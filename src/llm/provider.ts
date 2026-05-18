/**
 * LLM provider interface for geas-agent.
 *
 * **Why this exists before any concrete vendor call.** The cost/quality
 * tradeoff between candidate models is not settled (see geas-server #585: the
 * benchmark recommends shipping cached Anthropic Haiku 4.5 first, but Niall
 * makes the final call and Gemini Flash 2.5 remains in play). The harness must
 * be able to swap vendors in a single file. So we lock the request/response
 * shape *before* there is a consumer, and ship only a `NoopProvider` test
 * double here — no network, no SDK dependency.
 *
 * **Why the Anthropic `messages` shape is the common denominator.** Per #585's
 * "wire one well first" design note: Anthropic's explicit `cache_control`
 * contract is the strictest of the candidates. Gemini's implicit caching is
 * "configure nothing"-easy to layer on top of a request type that already has
 * explicit cache markers; the reverse (retrofitting cache markers onto a
 * Gemini-shaped type) forces a refactor of every caller. So the request type
 * is Haiku-shaped and a Gemini adapter will simply ignore the markers.
 *
 * **Design constraints baked in here:**
 *
 *   1. **Never throw on a provider/transport failure.** Mirrors the
 *      `GeasMcpClient` contract (`src/mcp/errors.ts`): callers always get a
 *      discriminated `Result<T>` so agent loops stay deterministic and
 *      driveable in tests. Programmer errors (malformed request) may still
 *      throw — they're bugs, not runtime conditions.
 *
 *   2. **Usage telemetry is part of the result, always.** geas-server #585
 *      makes cost-per-active-hour a product-viability gate. Every concrete
 *      provider must report tokens (including cache read / cache creation
 *      split) so cost can be aggregated honestly. The `NoopProvider` reports
 *      zeroed usage rather than omitting it, so consumers can rely on the
 *      field's presence.
 *
 *   3. **Cache-control markers live on the request, not in provider config.**
 *      What is cacheable (system prompt, tool defs, a stable suffix of game
 *      state) is a per-call decision the harness makes, not a provider-global
 *      setting. The markers therefore ride on `system` blocks and tool defs.
 */

/** Anthropic-style explicit prompt-cache marker. `ephemeral` = ~5min TTL. */
export interface CacheControl {
  readonly type: 'ephemeral';
}

/** A text content block. */
export interface TextBlock {
  readonly type: 'text';
  readonly text: string;
  /**
   * When set, the provider is asked to cache the prefix up to and including
   * this block. Anthropic-shaped; ignored by providers without explicit
   * caching (e.g. a future Gemini adapter relying on implicit caching).
   */
  readonly cacheControl?: CacheControl;
}

/** A model request to invoke a tool. Emitted by the model in a result. */
export interface ToolUseBlock {
  readonly type: 'tool_use';
  /** Provider-assigned call id; echoed back in the matching `tool_result`. */
  readonly id: string;
  readonly name: string;
  /** Parsed JSON arguments the model produced for the tool. */
  readonly input: Record<string, unknown>;
}

/** The caller's response to a `tool_use`, fed back on the next turn. */
export interface ToolResultBlock {
  readonly type: 'tool_result';
  /** Must match the originating {@link ToolUseBlock.id}. */
  readonly toolUseId: string;
  /** Serialized tool output (typically JSON-stringified MCP result). */
  readonly content: string;
  /** True when the tool call failed; lets the model self-correct. */
  readonly isError?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export type LlmRole = 'user' | 'assistant';

export interface LlmMessage {
  readonly role: LlmRole;
  readonly content: readonly ContentBlock[];
}

/**
 * Tool definition handed to the model. `inputSchema` is a JSON Schema object —
 * the same shape geas-server's MCP tools expose, so the harness can pass MCP
 * tool schemas straight through.
 */
export interface LlmToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /**
   * Cache the tool-definition prefix up to and including this tool. Tool defs
   * are large and stable across a session — prime caching candidates.
   */
  readonly cacheControl?: CacheControl;
}

/** Why the model stopped producing tokens. Anthropic-style stop reasons. */
export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence';

/**
 * Token accounting for one generate call. The cache split matters: #585's
 * cost model treats cache reads as ~10x cheaper than uncached input, so a
 * single `inputTokens` number would make provider comparison dishonest.
 */
export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Input tokens served from cache (cheap). */
  readonly cacheReadInputTokens: number;
  /** Input tokens written to cache this call (one-time premium). */
  readonly cacheCreationInputTokens: number;
}

export interface GenerateRequest {
  /**
   * System prompt as blocks so individual segments can carry cache markers
   * (e.g. cache the stable persona prefix, leave a volatile suffix uncached).
   */
  readonly system?: readonly TextBlock[];
  readonly messages: readonly LlmMessage[];
  readonly tools?: readonly LlmToolDef[];
  /** Hard cap on output tokens. Provider default applies when omitted. */
  readonly maxTokens?: number;
  /** 0..1. Provider default applies when omitted. */
  readonly temperature?: number;
  /** Cooperative cancellation, threaded through to the vendor SDK. */
  readonly signal?: AbortSignal;
}

export interface GenerateResult {
  readonly stopReason: StopReason;
  readonly content: readonly ContentBlock[];
  readonly usage: LlmUsage;
  /** Concrete model id that served the request, for telemetry attribution. */
  readonly model?: string;
}

/**
 * Typed provider error. Parallels `GeasMcpError` so the agent loop can handle
 * MCP and LLM failures with one mental model.
 *
 *   - `transport`     — network / SSE / HTTP-level failure.
 *   - `unauthorized`  — bad / missing API key.
 *   - `rate_limit`    — 429 / provider throttling; caller may back off + retry.
 *   - `overloaded`    — provider-side 5xx / capacity; retryable.
 *   - `invalid_request` — request the provider rejected (our bug).
 *   - `invalid_response` — provider returned something we couldn't parse.
 *   - `timeout`       — exceeded the configured wall budget.
 *   - `aborted`       — caller cancelled via AbortSignal.
 */
export type LlmErrorKind =
  | 'transport'
  | 'unauthorized'
  | 'rate_limit'
  | 'overloaded'
  | 'invalid_request'
  | 'invalid_response'
  | 'timeout'
  | 'aborted';

export interface LlmError {
  readonly kind: LlmErrorKind;
  readonly message: string;
  /** Original error if one was caught — logging only, not control flow. */
  readonly cause?: unknown;
  /** True for kinds a retry loop may reasonably re-attempt. */
  readonly retryable: boolean;
}

export type LlmOk<T> = { ok: true; value: T };
export type LlmErr = { ok: false; error: LlmError };
export type LlmResult<T> = LlmOk<T> | LlmErr;

export function llmOk<T>(value: T): LlmOk<T> {
  return { ok: true, value };
}

export function llmErr(error: LlmError): LlmErr {
  return { ok: false, error };
}

const RETRYABLE_KINDS: ReadonlySet<LlmErrorKind> = new Set<LlmErrorKind>([
  'transport',
  'rate_limit',
  'overloaded',
  'timeout',
]);

export function makeLlmError(
  kind: LlmErrorKind,
  message: string,
  opts: { cause?: unknown; retryable?: boolean } = {},
): LlmError {
  return {
    kind,
    message,
    cause: opts.cause,
    retryable: opts.retryable ?? RETRYABLE_KINDS.has(kind),
  };
}

/**
 * One streamed event. Text is delivered incrementally; a single terminal
 * `result` (or `error`) closes the stream. Concrete providers may also emit
 * tool-use deltas later — the union is intentionally open via `type`.
 */
export type StreamEvent =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'result'; readonly result: GenerateResult }
  | { readonly type: 'error'; readonly error: LlmError };

/**
 * The one-file vendor seam. A concrete provider wraps exactly one SDK and
 * translates to/from these types. Swapping vendors = a new file implementing
 * this interface; no caller changes.
 */
export interface LlmProvider {
  /** Stable identifier for telemetry / logs (e.g. `anthropic`, `gemini`). */
  readonly name: string;
  generate(req: GenerateRequest): Promise<LlmResult<GenerateResult>>;
  streamGenerate(req: GenerateRequest): AsyncIterable<StreamEvent>;
}

export function isTextBlock(b: ContentBlock): b is TextBlock {
  return b.type === 'text';
}

export function isToolUseBlock(b: ContentBlock): b is ToolUseBlock {
  return b.type === 'tool_use';
}

export function isToolResultBlock(b: ContentBlock): b is ToolResultBlock {
  return b.type === 'tool_result';
}

export const ZERO_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};
