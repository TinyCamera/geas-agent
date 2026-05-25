/**
 * Channel-A pub/sub hub (issue #667).
 *
 * Maps `(uid, characterId)` → list of live subscribers (WS connections)
 * and an `EventBuffer`. The runner emits `LoopEmitEvent`s; the hub wraps
 * each into a wire `ChannelAEvent`, stamps `eventId`/`ts`/`uid`/
 * `characterId`, buffers it for replay, and fans out to every live
 * subscriber for that stream.
 *
 * **Why one stream key is (uid, characterId), not sessionId.** A single
 * user can have multiple browser tabs (sessions) attached to one
 * character; they all share the same event stream. SessionId is opaque
 * to the hub — used only by `POST /chat` as a "where did this message
 * originate" tag.
 */

import type { LoopEmitEvent } from '../loop/runner.js';
import { EventBuffer } from './event-buffer.js';
import { PROTOCOL_VERSION, type ChannelAEvent } from './wire.js';

export interface Subscriber {
  /** Stable id (per WS connection). */
  readonly id: string;
  send(event: ChannelAEvent): void;
}

interface Stream {
  readonly buffer: EventBuffer;
  readonly subscribers: Map<string, Subscriber>;
}

export interface HubOptions {
  /** Optional clock injection — tests pin time. */
  readonly now?: () => number;
  /** Per-stream ring capacity. Default 256. */
  readonly bufferCapacity?: number;
}

function streamKey(uid: string, characterId: string): string {
  return `${uid}:${characterId}`;
}

export class EventHub {
  readonly #streams = new Map<string, Stream>();
  readonly #now: () => number;
  readonly #bufferCapacity: number;

  constructor(opts: HubOptions = {}) {
    this.#now = opts.now ?? (() => Date.now());
    this.#bufferCapacity = opts.bufferCapacity ?? 256;
  }

  /**
   * Build an emitter scoped to one `(uid, characterId)`. The runner
   * calls it with its own `LoopEmitEvent`; we lift to the wire format,
   * buffer, fan out. Returns the emitter and the stream key so callers
   * can subscribe / replay against it.
   */
  emitterFor(uid: string, characterId: string): (e: LoopEmitEvent) => void {
    const stream = this.#streamOrCreate(uid, characterId);
    return (e) => {
      const built = stream.buffer.append((eventId) =>
        this.#liftEvent(uid, characterId, e, eventId),
      );
      const stamped = built.event;
      for (const sub of stream.subscribers.values()) {
        try {
          sub.send(stamped);
        } catch {
          // ignore — the transport handles its own errors / cleanup.
        }
      }
    };
  }

  /**
   * Subscribe to a stream. The subscriber will receive every event
   * stamped after subscription. If `since` is provided, the hub also
   * replays any buffered events with `eventId > since` synchronously
   * before returning. Returns the actual `resumeCursor` — the latest
   * eventId already delivered (either replayed or 0 for a cold start).
   */
  subscribe(
    uid: string,
    characterId: string,
    sub: Subscriber,
    since: number = 0,
  ): { resumeCursor: number; replayed: number } {
    const stream = this.#streamOrCreate(uid, characterId);
    stream.subscribers.set(sub.id, sub);
    const missed = stream.buffer.since(since);
    for (const ev of missed) {
      try {
        sub.send(ev);
      } catch {
        // ignore
      }
    }
    return {
      resumeCursor: stream.buffer.lastEventId,
      replayed: missed.length,
    };
  }

  unsubscribe(uid: string, characterId: string, subId: string): void {
    const stream = this.#streams.get(streamKey(uid, characterId));
    if (!stream) return;
    stream.subscribers.delete(subId);
  }

  /** Count of live subscribers — telemetry / tests. */
  subscriberCount(uid: string, characterId: string): number {
    return this.#streams.get(streamKey(uid, characterId))?.subscribers.size ?? 0;
  }

  /** Send a synthetic event to a single subscriber (used for `hello`/`ping`). */
  sendDirect(sub: Subscriber, event: ChannelAEvent): void {
    try {
      sub.send(event);
    } catch {
      // ignore
    }
  }

  /** Last assigned eventId on a stream, 0 if none. */
  lastEventId(uid: string, characterId: string): number {
    return this.#streams.get(streamKey(uid, characterId))?.buffer.lastEventId ?? 0;
  }

  /**
   * Push a telemetry record onto a stream (buffered + fanned out like any
   * other event). The producer-side adapter that turns a
   * `TelemetryRecord` into one of these calls lives in
   * `./telemetry-sink.ts` (`createTelemetrySink` / `wrapLlmWithTelemetry`),
   * landed in #725.
   */
  emitTelemetry(
    uid: string,
    characterId: string,
    record: {
      provider: string;
      model: string;
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      latencyMs: number;
    },
  ): void {
    const stream = this.#streamOrCreate(uid, characterId);
    const built = stream.buffer.append((eventId) => ({
      protocolVersion: PROTOCOL_VERSION,
      eventId,
      ts: this.#now(),
      uid,
      characterId,
      type: 'telemetry',
      provider: record.provider,
      model: record.model,
      costUsd: record.costUsd,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheReadInputTokens: record.cacheReadInputTokens,
      cacheCreationInputTokens: record.cacheCreationInputTokens,
      latencyMs: record.latencyMs,
    }));
    for (const sub of stream.subscribers.values()) {
      try {
        sub.send(built.event);
      } catch {
        // ignore
      }
    }
  }

  #streamOrCreate(uid: string, characterId: string): Stream {
    const key = streamKey(uid, characterId);
    let s = this.#streams.get(key);
    if (!s) {
      s = {
        buffer: new EventBuffer(this.#bufferCapacity),
        subscribers: new Map(),
      };
      this.#streams.set(key, s);
    }
    return s;
  }

  #liftEvent(
    uid: string,
    characterId: string,
    e: LoopEmitEvent,
    eventId: number,
  ): ChannelAEvent {
    const base = {
      protocolVersion: PROTOCOL_VERSION,
      eventId,
      ts: this.#now(),
      uid,
      characterId,
    };
    switch (e.type) {
      case 'text-delta':
        return { ...base, type: 'text', text: e.text };
      case 'tool-call':
        return {
          ...base,
          type: 'tool_call',
          tool: e.plan.tool,
          args: e.plan.args,
          intent: e.plan.intent ?? null,
        };
      case 'tool-result': {
        const o = e.outcome;
        if (o.status === 'ok') {
          return {
            ...base,
            type: 'tool_result',
            tool: e.tool,
            status: 'ok',
            attempts: o.attempts,
            value: o.value,
          };
        }
        return {
          ...base,
          type: 'tool_result',
          tool: e.tool,
          status: o.status,
          attempts: o.attempts,
          lastFailure: 'lastFailure' in o ? o.lastFailure : undefined,
        };
      }
      case 'narration':
        return { ...base, type: 'narration', text: e.text };
      case 'decision':
        return {
          ...base,
          type: 'decision',
          decisionId: e.decisionId,
          payload: e.payload,
        };
      case 'error':
        return {
          ...base,
          type: 'error',
          message: e.message,
          cause: e.cause,
        };
      case 'done':
        return { ...base, type: 'done', reason: e.reason };
    }
  }
}
