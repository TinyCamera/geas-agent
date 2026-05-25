/**
 * Channel-A wire format (issue #667).
 *
 * The user-facing protocol that the REPL (#648), web client (#592), and
 * any future client speaks with the agent host. JSON-per-frame on the
 * WebSocket; HTTP for outbound messages.
 *
 * Versioning policy: every server-emitted event carries `protocolVersion`.
 * Bump on a breaking change (field removed, semantic change, type
 * narrowed). Additive changes (new optional field, new event type a
 * tolerant client can ignore) do not bump.
 */

export const PROTOCOL_VERSION = 1 as const;

/** Every server→client event shares this envelope. */
export interface EventEnvelope {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  /** Monotonic per-`(uid,characterId)`. Used by reconnect-resume. */
  readonly eventId: number;
  /** Server clock at emit, ms since epoch. */
  readonly ts: number;
  /** UID the event belongs to (the recipient's UID — never another user's). */
  readonly uid: string;
  /** Character whose runner produced the event. */
  readonly characterId: string;
}

export interface TextEvent extends EventEnvelope {
  readonly type: 'text';
  readonly text: string;
}

export interface ToolCallEvent extends EventEnvelope {
  readonly type: 'tool_call';
  readonly tool: string;
  readonly args: unknown;
  readonly intent: string | null;
}

export interface ToolResultEvent extends EventEnvelope {
  readonly type: 'tool_result';
  readonly tool: string;
  /** 'ok' | 'stuck' | 'exhausted' | 'gave_up' from the retry layer. */
  readonly status: string;
  readonly attempts: number;
  readonly value?: unknown;
  readonly lastFailure?: unknown;
}

export interface NarrationEvent extends EventEnvelope {
  readonly type: 'narration';
  readonly text: string;
}

export interface DecisionEvent extends EventEnvelope {
  readonly type: 'decision';
  readonly decisionId: string;
  readonly payload: unknown;
}

export interface ErrorEvent extends EventEnvelope {
  readonly type: 'error';
  readonly message: string;
  readonly cause?: unknown;
}

export interface DoneEvent extends EventEnvelope {
  readonly type: 'done';
  readonly reason: 'end_turn' | 'aborted';
}

/** Sent once on WS connect so the client can confirm the version handshake. */
export interface HelloEvent extends EventEnvelope {
  readonly type: 'hello';
  readonly serverProtocolVersion: typeof PROTOCOL_VERSION;
  /**
   * The eventId the client should treat as already-delivered after this
   * frame. If the client passed `?lastEventId=N`, the server has already
   * replayed events `[N+1 .. lastSentBeforeHello]`; everything after `hello`
   * is brand new.
   */
  readonly resumeCursor: number;
}

/** Heartbeat so clients can detect a half-open socket. */
export interface PingEvent extends EventEnvelope {
  readonly type: 'ping';
}

/**
 * Per-turn cost / token telemetry. Additive in protocol v1 — clients
 * that don't recognise the type can ignore it. The REPL (#648) prints
 * one dim cost line per record; the web client (#592) will render the
 * same fields. Mirrors `TelemetryRecord` (`src/llm/telemetry.ts`) on
 * the fields a client needs (no per-bucket cost split — clients render
 * a single dollar figure plus the in/out/cache breakdown).
 *
 * Producer wiring (TelemetryProvider → hub) is filed as a follow-up
 * sub-issue of #647 — #648 ships only the wire surface + client
 * renderer so the REPL can be unblocked.
 */
export interface TelemetryEvent extends EventEnvelope {
  readonly type: 'telemetry';
  readonly provider: string;
  readonly model: string;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly latencyMs: number;
}

export type ChannelAEvent =
  | TextEvent
  | ToolCallEvent
  | ToolResultEvent
  | NarrationEvent
  | DecisionEvent
  | ErrorEvent
  | DoneEvent
  | HelloEvent
  | PingEvent
  | TelemetryEvent;

/** POST /chat request body. */
export interface ChatRequest {
  /** Per-connection / per-tab identifier — opaque to the server. */
  readonly sessionId: string;
  /** Character whose runner should receive the message. */
  readonly characterId: string;
  readonly message: string;
}

/** POST /chat response body. 202 Accepted. */
export interface ChatAccepted {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly accepted: true;
  readonly sessionId: string;
  readonly characterId: string;
  /** Server clock when accepted, ms since epoch. */
  readonly ts: number;
}

/** Error body shared by POST endpoints. */
export interface ApiError {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly error: string;
  readonly message: string;
}

/**
 * Resolve-decision body (Channel B from the user side — the user picks an
 * option in response to a `decision` event the server pushed).
 */
export interface ResolveDecisionRequest {
  readonly sessionId: string;
  readonly characterId: string;
  readonly decisionId: string;
  /** Free-text reply that gets threaded back into the conversation. */
  readonly text: string;
}

/**
 * Row in the `GET /sessions` response (#650). One entry per
 * `(characterId, sessionId)` pair belonging to the authenticated UID.
 */
export interface SessionListingRow {
  readonly sessionId: string;
  readonly characterId: string;
  readonly displayName: string;
  /** ISO-8601 UTC of the most recent turn. */
  readonly lastActive: string;
  readonly turns: number;
  readonly totalCostUsd: number;
}

/** Response body for `GET /sessions`. Empty `sessions` is valid (no history). */
export interface ListSessionsResponse {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly uid: string;
  readonly sessions: readonly SessionListingRow[];
  readonly ts: number;
}
