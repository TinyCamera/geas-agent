/**
 * AnthropicProvider — concrete {@link LlmProvider} over `@anthropic-ai/sdk`.
 *
 * **Why Anthropic Haiku 4.5 first.** geas-server #585's benchmark recommends
 * shipping cached Haiku 4.5 as the first real provider: reliability over
 * marginal cost, and Anthropic's *explicit* `cache_control` contract is the
 * strictest of the candidates — building the harness against the strict shape
 * first means a future Gemini adapter just ignores the markers (see the design
 * note in `provider.ts`).
 *
 * **What this file owns and only this file.** It is the single vendor seam.
 * It translates the #609 interface types to/from the Anthropic `messages`
 * wire shape and never lets an SDK exception escape — every failure becomes a
 * typed {@link LlmResult} `Err`, mirroring `GeasMcpClient`'s contract so the
 * agent loop has one mental model for MCP and LLM faults. Programmer errors
 * (no API key) still throw at construction — that's a bug, not a runtime
 * condition.
 *
 * **Prompt caching.** Cache breakpoints are a per-call decision the harness
 * makes (#585 §3): the markers ride on `system` blocks and tool defs in the
 * request and are passed straight through as Anthropic `cache_control`. A
 * second call with an identical cached prefix returns `cache_read_input_tokens`
 * > 0 in usage — surfaced verbatim in {@link LlmUsage} so #585's cost model
 * stays honest. The live-gated integration test asserts the real cache hit.
 */

import Anthropic, {
  APIError,
  AuthenticationError,
  RateLimitError,
  InternalServerError,
  BadRequestError,
  UnprocessableEntityError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
} from '@anthropic-ai/sdk';

import {
  type ContentBlock,
  type GenerateRequest,
  type GenerateResult,
  type LlmErrorKind,
  type LlmMessage,
  type LlmProvider,
  type LlmResult,
  type LlmUsage,
  type StopReason,
  type StreamEvent,
  type TextBlock,
  type ToolResultBlock,
  type ToolUseBlock,
  isTextBlock,
  isToolUseBlock,
  llmErr,
  llmOk,
  makeLlmError,
} from './provider.js';

/** Benchmark winner per geas-server #585. Alias resolves to the latest snapshot. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5';
const DEFAULT_MAX_TOKENS = 2048;

export interface AnthropicProviderOptions {
  /** API key. Falls back to `process.env.ANTHROPIC_API_KEY`. */
  readonly apiKey?: string;
  /** Model id. Defaults to {@link DEFAULT_ANTHROPIC_MODEL}. */
  readonly model?: string;
  /** Default `max_tokens` when a request omits it. */
  readonly maxTokens?: number;
  /** Override the SDK client (tests). */
  readonly client?: AnthropicLike;
}

/** Minimal slice of the SDK surface this provider uses. */
export interface AnthropicLike {
  messages: {
    create(body: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  };
}

interface WireUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

const n = (v: number | null | undefined): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

function toUsage(u: WireUsage | undefined): LlmUsage {
  return {
    inputTokens: n(u?.input_tokens),
    outputTokens: n(u?.output_tokens),
    cacheReadInputTokens: n(u?.cache_read_input_tokens),
    cacheCreationInputTokens: n(u?.cache_creation_input_tokens),
  };
}

function toStopReason(raw: unknown): StopReason {
  switch (raw) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    default:
      // end_turn / refusal / pause_turn / unknown all collapse to end_turn —
      // the agent loop only branches on tool_use vs. not.
      return 'end_turn';
  }
}

// ---- request mapping --------------------------------------------------------

function mapSystem(system: GenerateRequest['system']): unknown[] | undefined {
  if (!system || system.length === 0) return undefined;
  return system.map((b) => ({
    type: 'text' as const,
    text: b.text,
    ...(b.cacheControl ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }));
}

function mapTools(tools: GenerateRequest['tools']): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
    ...(t.cacheControl ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }));
}

function mapContentBlock(b: ContentBlock): unknown {
  if (isTextBlock(b)) {
    const tb = b as TextBlock;
    return {
      type: 'text',
      text: tb.text,
      ...(tb.cacheControl ? { cache_control: { type: 'ephemeral' as const } } : {}),
    };
  }
  if (isToolUseBlock(b)) {
    const tu = b as ToolUseBlock;
    return { type: 'tool_use', id: tu.id, name: tu.name, input: tu.input };
  }
  // tool_result
  const tr = b as ToolResultBlock;
  return {
    type: 'tool_result',
    tool_use_id: tr.toolUseId,
    content: tr.content,
    is_error: tr.isError ?? false,
  };
}

function mapMessages(messages: readonly LlmMessage[]): unknown[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map(mapContentBlock),
  }));
}

function buildBody(
  req: GenerateRequest,
  model: string,
  defaultMaxTokens: number,
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: req.maxTokens ?? defaultMaxTokens,
    messages: mapMessages(req.messages),
  };
  const system = mapSystem(req.system);
  if (system) body.system = system;
  const tools = mapTools(req.tools);
  if (tools) body.tools = tools;
  if (typeof req.temperature === 'number') body.temperature = req.temperature;
  if (stream) body.stream = true;
  return body;
}

// ---- response mapping -------------------------------------------------------

interface WireMessage {
  content?: Array<Record<string, unknown>>;
  stop_reason?: unknown;
  usage?: WireUsage;
  model?: string;
}

function isWireMessage(v: unknown): v is WireMessage {
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray((v as { content?: unknown }).content) &&
    typeof (v as { usage?: unknown }).usage === 'object' &&
    (v as { usage?: unknown }).usage !== null
  );
}

function mapResponseContent(content: Array<Record<string, unknown>>): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text });
    } else if (
      block.type === 'tool_use' &&
      typeof block.id === 'string' &&
      typeof block.name === 'string'
    ) {
      out.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: (block.input as Record<string, unknown>) ?? {},
      });
    }
    // thinking / redacted_thinking / server tool blocks are intentionally
    // dropped — the harness does not consume them yet.
  }
  return out;
}

// ---- error mapping ----------------------------------------------------------

function classify(err: unknown): { kind: LlmErrorKind; message: string } {
  if (err instanceof APIUserAbortError) {
    return { kind: 'aborted', message: 'request aborted by caller' };
  }
  if (err instanceof APIConnectionTimeoutError) {
    return { kind: 'timeout', message: err.message || 'request timed out' };
  }
  if (err instanceof APIConnectionError) {
    return { kind: 'transport', message: err.message || 'connection failure' };
  }
  if (err instanceof AuthenticationError) {
    return { kind: 'unauthorized', message: err.message || 'bad or missing API key' };
  }
  if (err instanceof RateLimitError) {
    return { kind: 'rate_limit', message: err.message || 'rate limited' };
  }
  if (err instanceof InternalServerError) {
    return { kind: 'overloaded', message: err.message || 'provider overloaded' };
  }
  if (err instanceof BadRequestError || err instanceof UnprocessableEntityError) {
    return { kind: 'invalid_request', message: err.message || 'invalid request' };
  }
  if (err instanceof APIError) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) {
      return { kind: 'unauthorized', message: err.message };
    }
    if (status === 429) return { kind: 'rate_limit', message: err.message };
    if (typeof status === 'number' && status >= 500) {
      return { kind: 'overloaded', message: err.message };
    }
    if (typeof status === 'number' && status >= 400) {
      return { kind: 'invalid_request', message: err.message };
    }
    return { kind: 'transport', message: err.message };
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return { kind: 'aborted', message: 'request aborted' };
  }
  return {
    kind: 'transport',
    message: err instanceof Error ? err.message : String(err),
  };
}

function toErr(err: unknown): ReturnType<typeof llmErr> {
  const { kind, message } = classify(err);
  return llmErr(makeLlmError(kind, message, { cause: err }));
}

// ---- provider ---------------------------------------------------------------

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';

  #client: AnthropicLike;
  #model: string;
  #maxTokens: number;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.#model = opts.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.#maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

    if (opts.client) {
      this.#client = opts.client;
      return;
    }

    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      // Programmer/config error, not a runtime condition — fail loud, no
      // silent fallback (issue #610 acceptance).
      throw new Error(
        'AnthropicProvider: no API key. Pass { apiKey } or set ANTHROPIC_API_KEY.',
      );
    }
    this.#client = new Anthropic({ apiKey }) as unknown as AnthropicLike;
  }

  async generate(req: GenerateRequest): Promise<LlmResult<GenerateResult>> {
    const body = buildBody(req, this.#model, this.#maxTokens, false);
    let raw: unknown;
    try {
      raw = await this.#client.messages.create(
        body,
        req.signal ? { signal: req.signal } : undefined,
      );
    } catch (err) {
      return toErr(err);
    }

    if (!isWireMessage(raw)) {
      return llmErr(
        makeLlmError('invalid_response', 'Anthropic response missing content/usage'),
      );
    }

    return llmOk({
      stopReason: toStopReason(raw.stop_reason),
      content: mapResponseContent(raw.content ?? []),
      usage: toUsage(raw.usage),
      model: raw.model,
    });
  }

  async *streamGenerate(req: GenerateRequest): AsyncIterable<StreamEvent> {
    const body = buildBody(req, this.#model, this.#maxTokens, true);

    let stream: AsyncIterable<Record<string, unknown>>;
    try {
      stream = (await this.#client.messages.create(
        body,
        req.signal ? { signal: req.signal } : undefined,
      )) as AsyncIterable<Record<string, unknown>>;
    } catch (err) {
      yield { type: 'error', error: toErr(err).error };
      return;
    }

    // Accumulators keyed by content-block index, in arrival order.
    const blocks: Array<{
      type: 'text' | 'tool_use';
      text: string;
      id?: string;
      name?: string;
      json: string;
    }> = [];
    let model: string | undefined;
    let stopReason: StopReason = 'end_turn';
    const usage: WireUsage = {};

    try {
      for await (const ev of stream) {
        switch (ev.type) {
          case 'message_start': {
            const msg = ev.message as { model?: string; usage?: WireUsage } | undefined;
            model = msg?.model;
            if (msg?.usage) {
              usage.input_tokens = msg.usage.input_tokens;
              usage.cache_read_input_tokens = msg.usage.cache_read_input_tokens;
              usage.cache_creation_input_tokens = msg.usage.cache_creation_input_tokens;
            }
            break;
          }
          case 'content_block_start': {
            const idx = ev.index as number;
            const cb = ev.content_block as Record<string, unknown>;
            if (cb.type === 'tool_use') {
              blocks[idx] = {
                type: 'tool_use',
                text: '',
                id: cb.id as string,
                name: cb.name as string,
                json: '',
              };
            } else {
              blocks[idx] = { type: 'text', text: '', json: '' };
            }
            break;
          }
          case 'content_block_delta': {
            const idx = ev.index as number;
            const delta = ev.delta as Record<string, unknown>;
            const slot = blocks[idx];
            if (!slot) break;
            if (delta.type === 'text_delta' && typeof delta.text === 'string') {
              slot.text += delta.text;
              yield { type: 'text_delta', text: delta.text };
            } else if (
              delta.type === 'input_json_delta' &&
              typeof delta.partial_json === 'string'
            ) {
              slot.json += delta.partial_json;
            }
            break;
          }
          case 'message_delta': {
            const delta = ev.delta as { stop_reason?: unknown } | undefined;
            if (delta?.stop_reason !== undefined) {
              stopReason = toStopReason(delta.stop_reason);
            }
            const u = ev.usage as WireUsage | undefined;
            if (u?.output_tokens != null) usage.output_tokens = u.output_tokens;
            break;
          }
          case 'message_stop':
          case 'content_block_stop':
          default:
            break;
        }
      }
    } catch (err) {
      yield { type: 'error', error: toErr(err).error };
      return;
    }

    const content: ContentBlock[] = [];
    for (const slot of blocks) {
      if (!slot) continue;
      if (slot.type === 'text') {
        content.push({ type: 'text', text: slot.text });
      } else {
        let input: Record<string, unknown> = {};
        if (slot.json.trim().length > 0) {
          try {
            input = JSON.parse(slot.json) as Record<string, unknown>;
          } catch {
            // Leave input empty rather than failing the whole turn — a
            // malformed tool arg surfaces to the model as an empty call it
            // can retry, matching the non-throwing contract.
            input = {};
          }
        }
        content.push({
          type: 'tool_use',
          id: slot.id ?? '',
          name: slot.name ?? '',
          input,
        });
      }
    }

    yield {
      type: 'result',
      result: {
        stopReason,
        content,
        usage: toUsage(usage),
        model,
      },
    };
  }
}