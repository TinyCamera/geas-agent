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
  /**
   * `unknown` on the wire so legacy / forward-compat shapes don't break
   * tolerant consumers (the REPL's `parsePayload` in `repl/decisions.ts`
   * decodes defensively). Producers SHOULD emit a `DecisionPayload` —
   * narrow with `isDecisionPayload(...)` before treating as typed.
   */
  readonly payload: unknown;
}

// ---------- Decision payloads (#697) ----------

/**
 * One pickable option in a level-up / build-picker / character-creation
 * modal. `detail` is a free-form bag for renderer hints (stat costs,
 * trait tags, etc) — agents and clients pass it through verbatim.
 */
export interface DecisionOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly detail?: Record<string, unknown>;
}

/** A single stat the character-creation flow asks the user to allocate. */
export interface StatSpec {
  readonly id: string;
  readonly label: string;
  readonly min?: number;
  readonly max?: number;
}

export interface LevelUpDecisionPayload {
  readonly kind: 'level_up';
  readonly options: readonly DecisionOption[];
  /** Optional UI-side deadline (ms since epoch). Soft: server enforces. */
  readonly deadlineMs?: number;
}

export interface BuildPickerDecisionPayload {
  readonly kind: 'build_picker';
  readonly options: readonly DecisionOption[];
  /** Index into `options` the agent recommends, if any. */
  readonly suggestedIndex?: number;
  readonly deadlineMs?: number;
}

export interface CharacterCreationDecisionPayload {
  readonly kind: 'character_creation';
  /** Build templates the user picks from after allocating stats. */
  readonly options: readonly DecisionOption[];
  /** Stats the user must allocate. Default set lives in the REPL parser. */
  readonly stats?: readonly StatSpec[];
  /** Total points available across `stats`. */
  readonly statBudget?: number;
  readonly deadlineMs?: number;
}

/**
 * Discriminated union of every decision payload kind the agent can emit
 * (issue #697). Tagged on `kind`. Keep this exhaustive: adding a new
 * decision kind means a new variant here AND a matching `DecisionResponse`
 * variant below.
 */
export type DecisionPayload =
  | LevelUpDecisionPayload
  | BuildPickerDecisionPayload
  | CharacterCreationDecisionPayload;

/**
 * Runtime typeguard. Tolerant — only checks the discriminator + the
 * structural minimum each variant needs. `unknown` extra fields are
 * allowed (forward-compat).
 */
export function isDecisionPayload(value: unknown): value is DecisionPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as { kind?: unknown; options?: unknown };
  if (
    v.kind !== 'level_up' &&
    v.kind !== 'build_picker' &&
    v.kind !== 'character_creation'
  ) {
    return false;
  }
  return Array.isArray(v.options);
}

// ---------- Decision responses (#697) ----------

/**
 * User's reply to a `DecisionEvent`. Discriminated on `kind` (same tag
 * the payload uses). Carried in `ResolveDecisionRequest.text` as JSON —
 * see `encodeDecisionResponse` / `decodeDecisionResponse`. Free-text
 * replies are still accepted on the wire for tolerant agents; the typed
 * envelope is the canonical shape clients SHOULD send.
 */
export interface LevelUpDecisionResponse {
  readonly kind: 'level_up';
  readonly optionId: string;
}

export interface BuildPickerDecisionResponse {
  readonly kind: 'build_picker';
  readonly optionId: string;
}

export interface CharacterCreationDecisionResponse {
  readonly kind: 'character_creation';
  readonly name: string;
  readonly stats: Readonly<Record<string, number>>;
  readonly buildId: string;
}

export type DecisionResponse =
  | LevelUpDecisionResponse
  | BuildPickerDecisionResponse
  | CharacterCreationDecisionResponse;

/**
 * Schema version stamped onto an encoded `DecisionResponse`. Bump on a
 * breaking change to any variant. Additive fields (new optional key) do
 * not bump.
 */
export const DECISION_RESPONSE_SCHEMA_VERSION = 1 as const;

interface EncodedDecisionResponse {
  readonly schemaVersion: typeof DECISION_RESPONSE_SCHEMA_VERSION;
  readonly response: DecisionResponse;
}

/**
 * Encode a typed `DecisionResponse` into the JSON string that goes in
 * `ResolveDecisionRequest.text`. Round-trips through
 * `decodeDecisionResponse`.
 */
export function encodeDecisionResponse(response: DecisionResponse): string {
  const envelope: EncodedDecisionResponse = {
    schemaVersion: DECISION_RESPONSE_SCHEMA_VERSION,
    response,
  };
  return JSON.stringify(envelope);
}

/**
 * Decode the `text` field of a `ResolveDecisionRequest` into a typed
 * `DecisionResponse`. Returns `null` if the text isn't a typed envelope
 * (legacy free-text reply, timeout sentinel, etc) — callers should fall
 * back to whatever tolerant parser they had before.
 */
export function decodeDecisionResponse(text: string): DecisionResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const env = parsed as { schemaVersion?: unknown; response?: unknown };
  if (env.schemaVersion !== DECISION_RESPONSE_SCHEMA_VERSION) return null;
  return isDecisionResponse(env.response) ? env.response : null;
}

/**
 * Runtime typeguard for `DecisionResponse`. Exhaustive on the
 * discriminator; structural-minimum on each variant.
 */
export function isDecisionResponse(value: unknown): value is DecisionResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.kind === 'level_up' || v.kind === 'build_picker') {
    return typeof v.optionId === 'string';
  }
  if (v.kind === 'character_creation') {
    if (typeof v.name !== 'string' || typeof v.buildId !== 'string') return false;
    if (!v.stats || typeof v.stats !== 'object' || Array.isArray(v.stats)) return false;
    return Object.values(v.stats as Record<string, unknown>).every(
      (n) => typeof n === 'number' && Number.isFinite(n),
    );
  }
  return false;
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
 * Producer wiring (TelemetryProvider → hub) shipped in #725 — see
 * `src/server/telemetry-sink.ts` (`createTelemetrySink`,
 * `wrapLlmWithTelemetry`). #648 shipped only the wire surface + client
 * renderer so the REPL could be unblocked.
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
 * POST /chat/sync response body (issue #736). Synchronous test-client
 * surface — the assembled outcome of one turn. The full `TurnResult`
 * type lives in `./assemble-turn.ts` so the assembler can be unit-tested
 * without dragging in HTTP plumbing.
 *
 * On timeout the response is 504 with this same envelope plus
 * `partialTurn` carrying whatever was assembled before the wait window
 * elapsed.
 */
export interface SyncChatResponse {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly characterId: string;
  readonly ts: number;
  readonly turn: import('./assemble-turn.js').TurnResult;
}

export interface SyncChatTimeoutResponse {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly error: 'timeout';
  readonly message: string;
  readonly partialTurn: import('./assemble-turn.js').TurnResult;
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
