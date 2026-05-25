/**
 * Per-(uid,characterId) bounded ring buffer of recent events for resume.
 *
 * **Why this exists.** Issue #667 acceptance criterion: "Reconnect after
 * transient disconnect works (resume same session)." A WS client that
 * blips for 5–60s should be able to reconnect and recover the events it
 * missed. We solve this with a small per-stream ring buffer.
 *
 * **Why a ring, not Firestore.** Firestore is the long-term conversation
 * record (#665 — `agent_conversations/...`). That's the right store for
 * "what happened in this character's whole history". Resume after a
 * 5s blip is a transport concern with a different access pattern (last
 * N events, in order, cheap, in-process). A 256-event ring fits both
 * memory and the realistic blip window.
 *
 * **What's NOT here.** Cross-process resume (e.g. agent host restart):
 * out of scope. The buffer is in-memory. On host restart the WS reconnects
 * receive `hello` with `resumeCursor=0` and start fresh — the client can
 * fall back to Firestore replay (#665) if it wants full history. We
 * document this explicitly in `agent.md` updates.
 */

import type { ChannelAEvent } from './wire.js';

const DEFAULT_CAPACITY = 256;

interface BufferedEvent {
  readonly eventId: number;
  readonly event: ChannelAEvent;
}

export class EventBuffer {
  #cap: number;
  #events: BufferedEvent[] = [];
  /** Next eventId to assign. Monotonic, never reused. */
  #nextId = 1;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    if (capacity <= 0) throw new Error('EventBuffer capacity must be > 0');
    this.#cap = capacity;
  }

  /**
   * Assign an id and append the event built by `stamp`. The hub passes a
   * factory so the stored event already has the correct `eventId` baked
   * into the wire envelope — replays then see the exact same shape live
   * subscribers received.
   */
  append(stamp: (eventId: number) => ChannelAEvent): {
    eventId: number;
    event: ChannelAEvent;
  } {
    const eventId = this.#nextId++;
    const event = stamp(eventId);
    this.#events.push({ eventId, event });
    if (this.#events.length > this.#cap) {
      this.#events.shift();
    }
    return { eventId, event };
  }

  /** Most recent assigned id (0 if none assigned yet). */
  get lastEventId(): number {
    return this.#nextId - 1;
  }

  /**
   * Replay events strictly newer than `since`. Capped to whatever the
   * ring still holds. If `since` is older than the oldest buffered event,
   * the caller gets a partial replay — the resume cursor on the `hello`
   * frame tells them where they actually picked up.
   */
  since(since: number): readonly ChannelAEvent[] {
    if (since >= this.lastEventId) return [];
    const out: ChannelAEvent[] = [];
    for (const buffered of this.#events) {
      if (buffered.eventId > since) out.push(buffered.event);
    }
    return out;
  }

  /** Test helper. Returns the smallest buffered id, or 0 if empty. */
  get oldestEventId(): number {
    return this.#events[0]?.eventId ?? 0;
  }

  /** Test helper. */
  get size(): number {
    return this.#events.length;
  }
}
