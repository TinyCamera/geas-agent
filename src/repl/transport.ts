/**
 * Channel-A transport client (issue #648).
 *
 * A thin Node client over the wire format shipped in #667:
 *   - `POST /chat`  to send a user message
 *   - `WS /events`  to receive a typed `ChannelAEvent` stream
 *
 * **Renderer-agnostic by design.** The transport emits typed events on a
 * single callback; how the caller renders them is its problem. This is
 * deliberate — the eventual web client (#592) will lift this module
 * wholesale and only swap the renderer (`cli.ts` → React).
 *
 * **Reconnect-on-drop.** A transient WS disconnect (`close` event with
 * non-1000 code, or an unexpected `error`) triggers 3 retries with
 * exponential backoff (250 / 750 / 2000 ms). On reconnect we pass
 * `?lastEventId=<lastSeenEventId>` so the server replays buffered events
 * we missed (the hub's 256-event ring window). After 3 failed retries we
 * surface a terminal `disconnect` to the caller and stop.
 *
 * **No decision handling.** `DecisionEvent` is forwarded as-is; resolve
 * round-trip is deferred to #649. **No session resume.** We mint a
 * sessionId per process invocation; resume across reboots is #650.
 */

import WebSocket from 'ws';
import {
  type ChannelAEvent,
  PROTOCOL_VERSION,
  type ChatAccepted,
  type ApiError,
} from '../server/wire.js';

export interface TransportOptions {
  readonly baseUrl: string;
  /** Bearer token for POST /chat AND `?token=` for the WS upgrade. */
  readonly token: string;
  /** Character to talk to — pins the (uid,characterId) stream key. */
  readonly characterId: string;
  /** Per-process session tag. Opaque to the server. */
  readonly sessionId: string;
  /** Backoff schedule, ms. Defaults to [250, 750, 2000]. */
  readonly retryBackoffMs?: readonly number[];
  /** Override the WebSocket ctor (tests). */
  readonly wsCtor?: typeof WebSocket;
  /** Override `fetch` (tests). */
  readonly fetchImpl?: typeof fetch;
  /** Sleep seam — tests skip real time. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export type TransportEvent =
  /** A typed wire event from the server. */
  | { readonly type: 'event'; readonly event: ChannelAEvent }
  /** Transient: WS dropped, retrying. */
  | { readonly type: 'reconnecting'; readonly attempt: number; readonly delayMs: number }
  /** Terminal: retries exhausted. The transport is dead. */
  | { readonly type: 'disconnected'; readonly reason: string }
  /** First successful open. */
  | { readonly type: 'connected'; readonly resumeCursor: number };

export type TransportListener = (event: TransportEvent) => void;

const DEFAULT_BACKOFF = [250, 750, 2000] as const;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parse one inbound WS frame into a typed event. Throws on malformed input. */
export function parseEventFrame(raw: string | Buffer): ChannelAEvent {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`event frame: not valid JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('event frame: not an object');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `event frame: protocolVersion ${String(obj.protocolVersion)} != ${PROTOCOL_VERSION}`,
    );
  }
  if (typeof obj.type !== 'string') {
    throw new Error('event frame: missing type');
  }
  // Trust the typed wire — but enforce required envelope fields.
  if (typeof obj.eventId !== 'number' || typeof obj.ts !== 'number') {
    throw new Error('event frame: missing eventId/ts');
  }
  if (typeof obj.uid !== 'string' || typeof obj.characterId !== 'string') {
    throw new Error('event frame: missing uid/characterId');
  }
  return parsed as ChannelAEvent;
}

export class Transport {
  readonly #opts: Required<
    Pick<
      TransportOptions,
      'baseUrl' | 'token' | 'characterId' | 'sessionId'
    >
  > & {
    retryBackoffMs: readonly number[];
    wsCtor: typeof WebSocket;
    fetchImpl: typeof fetch;
    sleep: (ms: number) => Promise<void>;
  };

  #listener: TransportListener | null = null;
  #ws: WebSocket | null = null;
  #lastEventId = 0;
  #closed = false;
  #connected = false;
  #connectResolvers: Array<{
    resolve: (resumeCursor: number) => void;
    reject: (e: Error) => void;
  }> = [];

  constructor(opts: TransportOptions) {
    this.#opts = {
      baseUrl: opts.baseUrl.replace(/\/$/, ''),
      token: opts.token,
      characterId: opts.characterId,
      sessionId: opts.sessionId,
      retryBackoffMs: opts.retryBackoffMs ?? DEFAULT_BACKOFF,
      wsCtor: opts.wsCtor ?? (WebSocket as unknown as typeof WebSocket),
      fetchImpl: opts.fetchImpl ?? fetch,
      sleep: opts.sleep ?? defaultSleep,
    };
  }

  on(listener: TransportListener): void {
    this.#listener = listener;
  }

  /** Open the WS. Resolves once the `hello` frame lands. */
  async connect(): Promise<number> {
    if (this.#closed) throw new Error('transport closed');
    return new Promise<number>((resolve, reject) => {
      this.#connectResolvers.push({ resolve, reject });
      void this.#openOnce(0);
    });
  }

  /** Send a chat message. Throws on non-2xx. */
  async send(message: string): Promise<ChatAccepted> {
    if (this.#closed) throw new Error('transport closed');
    const url = `${this.#opts.baseUrl}/chat`;
    const res = await this.#opts.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.#opts.token}`,
      },
      body: JSON.stringify({
        sessionId: this.#opts.sessionId,
        characterId: this.#opts.characterId,
        message,
      }),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`POST /chat: ${res.status} ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const err = parsed as ApiError;
      throw new Error(`POST /chat: ${res.status} ${err.error}: ${err.message}`);
    }
    return parsed as ChatAccepted;
  }

  /** Post the user's choice for a server-pushed decision. Throws on non-2xx.
   *  The `text` field is whatever `decisions.serializeChoice` produces —
   *  optionId for simple decisions, a JSON envelope for character creation. */
  async resolveDecision(decisionId: string, text: string): Promise<ChatAccepted> {
    if (this.#closed) throw new Error('transport closed');
    const url = `${this.#opts.baseUrl}/resolve-decision`;
    const res = await this.#opts.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.#opts.token}`,
      },
      body: JSON.stringify({
        sessionId: this.#opts.sessionId,
        characterId: this.#opts.characterId,
        decisionId,
        text,
      }),
    });
    const raw = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`POST /resolve-decision: ${res.status} ${raw.slice(0, 200)}`);
    }
    if (!res.ok) {
      const err = parsed as ApiError;
      throw new Error(
        `POST /resolve-decision: ${res.status} ${err.error}: ${err.message}`,
      );
    }
    return parsed as ChatAccepted;
  }

  /** Shutdown — closes the WS cleanly, no further events. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#ws?.close(1000, 'client closing');
    } catch {
      // ignore
    }
  }

  /** Last wire eventId we've seen — exposed for tests. */
  get lastEventId(): number {
    return this.#lastEventId;
  }

  async #openOnce(attempt: number): Promise<void> {
    if (this.#closed) return;
    const wsUrl = this.#buildWsUrl();
    const ws = new this.#opts.wsCtor(wsUrl);
    this.#ws = ws;

    ws.on('message', (raw) => {
      let event: ChannelAEvent;
      try {
        event = parseEventFrame(raw as Buffer);
      } catch (e) {
        this.#emit({ type: 'event', event: this.#syntheticError((e as Error).message) });
        return;
      }
      // Track delivered cursor for reconnect-resume.
      if (event.eventId > this.#lastEventId) {
        this.#lastEventId = event.eventId;
      }
      if (event.type === 'hello') {
        this.#connected = true;
        const resumeCursor = event.resumeCursor;
        // Drain pending connect() resolvers.
        const pending = this.#connectResolvers;
        this.#connectResolvers = [];
        for (const r of pending) r.resolve(resumeCursor);
        this.#emit({ type: 'connected', resumeCursor });
        return;
      }
      this.#emit({ type: 'event', event });
    });

    ws.on('close', (code) => {
      this.#ws = null;
      if (this.#closed) return;
      // Clean shutdown from the server side too — don't reconnect.
      if (code === 1000) {
        this.#emit({ type: 'disconnected', reason: 'server closed (1000)' });
        return;
      }
      void this.#scheduleReconnect(attempt + 1, `ws closed ${code}`);
    });

    ws.on('error', (err) => {
      // 'error' usually precedes 'close'; we handle reconnect there.
      if (!this.#connected && this.#connectResolvers.length > 0) {
        // Initial connection failed — surface to the awaiting connect().
        // We still let 'close' fire to drive backoff.
        const e = err as Error;
        for (const r of this.#connectResolvers) r.reject(e);
        this.#connectResolvers = [];
      }
    });
  }

  async #scheduleReconnect(attempt: number, reason: string): Promise<void> {
    if (this.#closed) return;
    const schedule = this.#opts.retryBackoffMs;
    if (attempt > schedule.length) {
      this.#emit({
        type: 'disconnected',
        reason: `${reason}; retries exhausted (${schedule.length})`,
      });
      // Reject any still-waiting connect().
      const pending = this.#connectResolvers;
      this.#connectResolvers = [];
      for (const r of pending) {
        r.reject(new Error(`transport disconnected: ${reason}`));
      }
      return;
    }
    const delayMs = schedule[attempt - 1];
    this.#emit({ type: 'reconnecting', attempt, delayMs });
    await this.#opts.sleep(delayMs);
    if (this.#closed) return;
    void this.#openOnce(attempt);
  }

  #buildWsUrl(): string {
    const httpBase = this.#opts.baseUrl;
    const wsBase = httpBase.replace(/^http/, 'ws');
    const params = new URLSearchParams({
      token: this.#opts.token,
      characterId: this.#opts.characterId,
    });
    if (this.#lastEventId > 0) {
      params.set('lastEventId', String(this.#lastEventId));
    }
    return `${wsBase}/events?${params.toString()}`;
  }

  #emit(ev: TransportEvent): void {
    this.#listener?.(ev);
  }

  #syntheticError(message: string): ChannelAEvent {
    return {
      protocolVersion: PROTOCOL_VERSION,
      eventId: this.#lastEventId,
      ts: Date.now(),
      uid: '',
      characterId: this.#opts.characterId,
      type: 'error',
      message,
    };
  }
}
