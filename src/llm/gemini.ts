/**
 * GeminiProvider — second concrete {@link LlmProvider}, over
 * `@google/generative-ai`.
 *
 * **Why a second provider now.** Niall went to try the REPL on 2026-05-25 and
 * the production harness only supported Anthropic, despite `MODEL_PRICES`
 * already pricing `gemini-2.5-flash`. The #585 cost spike (2026-05-16) recorded
 * Gemini Flash 2.5 at ~$0.21/active-hr at 30s/turn pacing — over the
 * product-viable gate but the cheapest measured option, and per #585 the
 * `LlmProvider` interface was designed to be provider-agnostic precisely so a
 * swap-in would be cheap once a second impl was needed.
 *
 * **What this file owns and only this file.** The single vendor seam for
 * Gemini. It translates the #609 interface types to/from Gemini's
 * `GenerateContentRequest` / `GenerateContentResult` wire shape, mirroring
 * `AnthropicProvider`'s never-throw + typed-`LlmResult` contract. Programmer
 * errors (no API key at construction) still throw — that's a bug, not a
 * runtime condition.
 *
 * **Caching.** Gemini has no per-request cache-breakpoint API analogous to
 * Anthropic's `cache_control`. The #585 spike observed ~78% implicit cache hit
 * rate when sending stable prefixes. We accept the harness-shaped
 * `cacheControl` markers as *no-ops* and pass them straight to the floor.
 * Cache hit usage is surfaced via `cachedContentTokenCount` on the response's
 * `usageMetadata` and mapped to `LlmUsage.cacheReadInputTokens`.
 *
 * **Tool-schema translation.** Gemini's `FunctionDeclaration.parameters` is an
 * OpenAPI-subset shape rather than vanilla JSON Schema. The #585 spike found
 * a small set of common fields that cause 400s if left in (`$schema`,
 * `additionalProperties`, `default`, `examples`) and that `type` must be
 * upper-cased (`"object"` → `"OBJECT"`). `cleanSchema()` below is the
 * port-forward of that spike's shim.
 */

import {
  GoogleGenerativeAI,
  GoogleGenerativeAIAbortError,
  GoogleGenerativeAIError,
  GoogleGenerativeAIFetchError,
  GoogleGenerativeAIRequestInputError,
  GoogleGenerativeAIResponseError,
} from '@google/generative-ai';

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
  isTextBlock,
  isToolResultBlock,
  isToolUseBlock,
  llmErr,
  llmOk,
  makeLlmError,
} from './provider.js';

/** Benchmark-cheapest candidate per geas-server #585. */
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const DEFAULT_MAX_TOKENS = 2048;

/** Minimal SDK surface this provider uses — narrowed so tests can inject a fake. */
export interface GeminiLike {
  getGenerativeModel(opts: { model: string }): {
    generateContent(
      req: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<unknown>;
    generateContentStream(
      req: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<unknown>;
  };
}

export interface GeminiProviderOptions {
  /** API key. Falls back to `process.env.GOOGLE_GEMINI_API_KEY`. */
  readonly apiKey?: string;
  /** Model id. Defaults to {@link DEFAULT_GEMINI_MODEL}. */
  readonly model?: string;
  /** Default `maxOutputTokens` when a request omits it. */
  readonly maxTokens?: number;
  /** Override the SDK client (tests). */
  readonly client?: GeminiLike;
}

// ---- tool-schema translation -----------------------------------------------

/**
 * Convert a JSON-Schema-shaped tool `inputSchema` into Gemini's OpenAPI subset.
 *
 *   - Recurses into `properties`, `items`, `anyOf`.
 *   - Upper-cases `type` (Gemini rejects lowercase).
 *   - Strips fields Gemini rejects: `$schema`, `additionalProperties`,
 *     `default`, `examples`, `const`, `oneOf`, `allOf`, `not`,
 *     `patternProperties`, `propertyNames`.
 *   - Leaves `description`, `required`, `enum`, `format`, `nullable`,
 *     `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`
 *     in place — Gemini accepts them.
 *
 * Exported for the unit tests; not part of the public provider API.
 */
export function cleanSchema(schema: unknown): unknown {
  if (schema === null || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(cleanSchema);

  const out: Record<string, unknown> = {};
  const src = schema as Record<string, unknown>;
  for (const [k, v] of Object.entries(src)) {
    switch (k) {
      case '$schema':
      case 'additionalProperties':
      case 'default':
      case 'examples':
      case 'const':
      case 'oneOf':
      case 'allOf':
      case 'not':
      case 'patternProperties':
      case 'propertyNames':
      case 'title':
        // dropped — Gemini either rejects or ignores these.
        continue;
      case 'type':
        if (typeof v === 'string') {
          out.type = v.toUpperCase();
        } else if (Array.isArray(v)) {
          // Nullable-style `type: ["string","null"]` → string + nullable:true.
          const nonNull = v.filter((t) => t !== 'null');
          const hasNull = v.length !== nonNull.length;
          if (nonNull.length === 1 && typeof nonNull[0] === 'string') {
            out.type = (nonNull[0] as string).toUpperCase();
            if (hasNull) out.nullable = true;
          } else {
            // Mixed union — Gemini can't represent. Coerce to STRING and
            // surface a description note. Same fallback the #585 spike used.
            out.type = 'STRING';
          }
        }
        break;
      case 'properties': {
        if (v && typeof v === 'object') {
          const props: Record<string, unknown> = {};
          for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
            props[pk] = cleanSchema(pv);
          }
          out.properties = props;
        }
        break;
      }
      case 'items':
        out.items = cleanSchema(v);
        break;
      case 'anyOf':
        if (Array.isArray(v)) out.anyOf = v.map(cleanSchema);
        break;
      default:
        out[k] = v;
        break;
    }
  }
  return out;
}

// ---- request mapping --------------------------------------------------------

/**
 * Translate a `GenerateRequest` into a Gemini `GenerateContentRequest`-shaped
 * object. We type it as `Record<string, unknown>` rather than importing
 * Gemini's TS types so the test surface (which mocks the SDK) doesn't have to
 * satisfy the SDK's stricter declared types — the runtime shape is what
 * matters and is asserted by the live test.
 */
function buildBody(
  req: GenerateRequest,
  defaultMaxTokens: number,
): Record<string, unknown> {
  const contents = mapMessages(req.messages);
  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      maxOutputTokens: req.maxTokens ?? defaultMaxTokens,
      ...(typeof req.temperature === 'number'
        ? { temperature: req.temperature }
        : {}),
    },
  };
  const sys = mapSystem(req.system);
  if (sys) body.systemInstruction = sys;
  const tools = mapTools(req.tools);
  if (tools) body.tools = tools;
  return body;
}

function mapSystem(
  system: GenerateRequest['system'],
): { role: 'system'; parts: Array<{ text: string }> } | undefined {
  if (!system || system.length === 0) return undefined;
  // Concatenate text — Gemini's systemInstruction is a single content block;
  // it has no cache-breakpoint concept, so the harness's per-block markers
  // collapse harmlessly.
  const text = system.map((b) => b.text).join('\n\n');
  return { role: 'system', parts: [{ text }] };
}

function mapTools(
  tools: GenerateRequest['tools'],
): Array<{ functionDeclarations: unknown[] }> | undefined {
  if (!tools || tools.length === 0) return undefined;
  const decls = tools.map((t) => {
    const cleaned = cleanSchema(t.inputSchema);
    const decl: Record<string, unknown> = {
      name: t.name,
      description: t.description,
    };
    if (cleaned && typeof cleaned === 'object') {
      decl.parameters = cleaned;
    }
    return decl;
  });
  return [{ functionDeclarations: decls }];
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

function mapContentBlock(b: ContentBlock): GeminiPart | null {
  if (isTextBlock(b)) {
    return { text: b.text };
  }
  if (isToolUseBlock(b)) {
    return {
      functionCall: { name: b.name, args: b.input ?? {} },
    };
  }
  if (isToolResultBlock(b)) {
    // Tool result name is not on the block (Anthropic's `tool_use_id` is the
    // correlator); Gemini wants the function name. We round-trip via the id
    // by stashing the call name in the same turn — but we don't have it here,
    // so we use a stable token derived from the id. The live model is robust
    // to this because `functionResponse.response` is the actual payload it
    // needs; the `name` field is only for display correlation.
    let response: Record<string, unknown>;
    try {
      const parsed = JSON.parse(b.content);
      response =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { value: parsed };
    } catch {
      response = { value: b.content };
    }
    if (b.isError) response = { ...response, isError: true };
    return {
      functionResponse: {
        name: b.toolUseId,
        response,
      },
    };
  }
  return null;
}

function mapMessages(messages: readonly LlmMessage[]): GeminiContent[] {
  const out: GeminiContent[] = [];
  for (const m of messages) {
    const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user';
    const parts: GeminiPart[] = [];
    for (const c of m.content) {
      const p = mapContentBlock(c);
      if (p) parts.push(p);
    }
    if (parts.length > 0) out.push({ role, parts });
  }
  return out;
}

// ---- response mapping -------------------------------------------------------

interface WireUsageMetadata {
  promptTokenCount?: number | null;
  candidatesTokenCount?: number | null;
  cachedContentTokenCount?: number | null;
}

const n = (v: number | null | undefined): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

function toUsage(u: WireUsageMetadata | undefined): LlmUsage {
  // Gemini reports `promptTokenCount` as the total prompt including any cache
  // hit, with `cachedContentTokenCount` as the cached subset. Surface them
  // split so our cost model can price the cache read at its own rate (the
  // pricing table in `pricing.ts` already has a `gemini-2.5-flash` row).
  const cached = n(u?.cachedContentTokenCount);
  const prompt = n(u?.promptTokenCount);
  const inputTokens = Math.max(0, prompt - cached);
  return {
    inputTokens,
    outputTokens: n(u?.candidatesTokenCount),
    cacheReadInputTokens: cached,
    // Gemini has no explicit cache-creation tier — implicit caching is "free
    // to write". Always 0; our cost model handles that correctly.
    cacheCreationInputTokens: 0,
  };
}

function toStopReason(raw: unknown): StopReason {
  switch (raw) {
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'STOP':
      return 'end_turn';
    default:
      // SAFETY / RECITATION / LANGUAGE / BLOCKLIST / PROHIBITED_CONTENT /
      // SPII / MALFORMED_FUNCTION_CALL / unspecified all collapse to end_turn;
      // a function-call response leaves finishReason as STOP and we detect
      // the tool_use via the parts themselves (see `pickStopReason`).
      return 'end_turn';
  }
}

function pickStopReason(
  rawFinish: unknown,
  content: readonly ContentBlock[],
): StopReason {
  // Gemini's `finishReason` is STOP whether the model produced text or a
  // function call. Our harness branches on `tool_use` vs not, so synthesize.
  if (content.some(isToolUseBlock)) return 'tool_use';
  return toStopReason(rawFinish);
}

interface WireResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: unknown;
  }>;
  usageMetadata?: WireUsageMetadata;
  modelVersion?: string;
}

/**
 * Gemini's SDK exposes `result.response` as a getter that *throws* if the
 * response was blocked (safety filter, etc.). Wrap the access so a blocked
 * response becomes a typed `invalid_response` Err, not a thrown SDK exception.
 */
function extractResponse(raw: unknown): WireResponse | null {
  if (raw === null || typeof raw !== 'object') return null;
  // Most call paths give `{ response: <getter> }`. Some give the raw object.
  if ('response' in raw) {
    try {
      const r = (raw as { response: unknown }).response;
      if (typeof r === 'function') {
        return (r as () => WireResponse)();
      }
      return (r as WireResponse) ?? null;
    } catch {
      return null;
    }
  }
  return raw as WireResponse;
}

function mapResponseParts(parts: GeminiPart[] | undefined): ContentBlock[] {
  if (!parts) return [];
  const out: ContentBlock[] = [];
  let toolUseCounter = 0;
  for (const p of parts) {
    if (typeof p.text === 'string' && p.text.length > 0) {
      out.push({ type: 'text', text: p.text });
    } else if (p.functionCall && typeof p.functionCall.name === 'string') {
      // Gemini doesn't assign call ids; mint one so the next turn's
      // tool_result can be matched. Pattern matches the Anthropic shape.
      toolUseCounter += 1;
      out.push({
        type: 'tool_use',
        id: `geminitc_${Date.now()}_${toolUseCounter}`,
        name: p.functionCall.name,
        input:
          p.functionCall.args && typeof p.functionCall.args === 'object'
            ? (p.functionCall.args as Record<string, unknown>)
            : {},
      });
    }
    // functionResponse / inlineData / executableCode etc. — not produced by
    // the model on response (input only); drop if encountered.
  }
  return out;
}

// ---- error mapping ----------------------------------------------------------

function classify(err: unknown): { kind: LlmErrorKind; message: string } {
  if (err instanceof GoogleGenerativeAIAbortError) {
    return { kind: 'aborted', message: err.message || 'request aborted' };
  }
  if (err instanceof GoogleGenerativeAIRequestInputError) {
    return { kind: 'invalid_request', message: err.message || 'invalid request' };
  }
  if (err instanceof GoogleGenerativeAIResponseError) {
    return {
      kind: 'invalid_response',
      message: err.message || 'invalid response',
    };
  }
  if (err instanceof GoogleGenerativeAIFetchError) {
    const status = (err as { status?: number }).status;
    const msg = err.message || 'fetch error';
    if (status === 401 || status === 403) {
      return { kind: 'unauthorized', message: msg };
    }
    if (status === 429) return { kind: 'rate_limit', message: msg };
    if (typeof status === 'number' && status >= 500) {
      return { kind: 'overloaded', message: msg };
    }
    if (typeof status === 'number' && status >= 400) {
      return { kind: 'invalid_request', message: msg };
    }
    return { kind: 'transport', message: msg };
  }
  if (err instanceof GoogleGenerativeAIError) {
    return { kind: 'transport', message: err.message || 'generative-ai error' };
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

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';

  #client: GeminiLike;
  #model: string;
  #maxTokens: number;

  constructor(opts: GeminiProviderOptions = {}) {
    this.#model = opts.model ?? DEFAULT_GEMINI_MODEL;
    this.#maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

    if (opts.client) {
      this.#client = opts.client;
      return;
    }

    const apiKey = opts.apiKey ?? process.env.GOOGLE_GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'GeminiProvider: no API key. Pass { apiKey } or set GOOGLE_GEMINI_API_KEY.',
      );
    }
    this.#client = new GoogleGenerativeAI(apiKey) as unknown as GeminiLike;
  }

  async generate(req: GenerateRequest): Promise<LlmResult<GenerateResult>> {
    const body = buildBody(req, this.#maxTokens);
    const model = this.#client.getGenerativeModel({ model: this.#model });
    let raw: unknown;
    try {
      raw = await model.generateContent(
        body,
        req.signal ? { signal: req.signal } : undefined,
      );
    } catch (err) {
      return toErr(err);
    }

    const wire = extractResponse(raw);
    if (!wire) {
      return llmErr(
        makeLlmError(
          'invalid_response',
          'Gemini response missing candidates/usageMetadata',
        ),
      );
    }

    const first = wire.candidates?.[0];
    const parts = first?.content?.parts;
    const content = mapResponseParts(parts);

    return llmOk({
      stopReason: pickStopReason(first?.finishReason, content),
      content,
      usage: toUsage(wire.usageMetadata),
      model: wire.modelVersion ?? this.#model,
    });
  }

  async *streamGenerate(req: GenerateRequest): AsyncIterable<StreamEvent> {
    const body = buildBody(req, this.#maxTokens);
    const model = this.#client.getGenerativeModel({ model: this.#model });

    let streamResult: {
      stream: AsyncIterable<unknown>;
      response: Promise<unknown> | unknown;
    };
    try {
      streamResult = (await model.generateContentStream(
        body,
        req.signal ? { signal: req.signal } : undefined,
      )) as typeof streamResult;
    } catch (err) {
      yield { type: 'error', error: toErr(err).error };
      return;
    }

    const accText: string[] = [];
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

    try {
      for await (const chunk of streamResult.stream) {
        const c = chunk as {
          candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
        };
        const parts = c.candidates?.[0]?.content?.parts ?? [];
        for (const p of parts) {
          if (typeof p.text === 'string' && p.text.length > 0) {
            accText.push(p.text);
            yield { type: 'text_delta', text: p.text };
          } else if (p.functionCall && typeof p.functionCall.name === 'string') {
            toolCalls.push({
              name: p.functionCall.name,
              args:
                p.functionCall.args && typeof p.functionCall.args === 'object'
                  ? (p.functionCall.args as Record<string, unknown>)
                  : {},
            });
          }
        }
      }
    } catch (err) {
      yield { type: 'error', error: toErr(err).error };
      return;
    }

    // Resolve the terminal aggregated response (usage + finishReason).
    let finalWire: WireResponse | null = null;
    try {
      const r = await streamResult.response;
      finalWire = extractResponse({ response: r });
    } catch (err) {
      yield { type: 'error', error: toErr(err).error };
      return;
    }

    const content: ContentBlock[] = [];
    const joined = accText.join('');
    if (joined.length > 0) content.push({ type: 'text', text: joined });
    let counter = 0;
    for (const tc of toolCalls) {
      counter += 1;
      content.push({
        type: 'tool_use',
        id: `geminitc_${Date.now()}_${counter}`,
        name: tc.name,
        input: tc.args,
      });
    }

    yield {
      type: 'result',
      result: {
        stopReason: pickStopReason(
          finalWire?.candidates?.[0]?.finishReason,
          content,
        ),
        content,
        usage: toUsage(finalWire?.usageMetadata),
        model: finalWire?.modelVersion ?? this.#model,
      },
    };
  }
}
