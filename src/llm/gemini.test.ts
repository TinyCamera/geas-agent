/**
 * GeminiProvider tests.
 *
 * Mocks `@google/generative-ai` at its single boundary
 * (`GoogleGenerativeAI.getGenerativeModel().generateContent`). Asserts:
 *
 *   - Request-shape translation: messages, system, tool defs (incl. `cleanSchema`).
 *   - `cache_control` markers from the harness are accepted as no-ops.
 *   - Usage extraction including `cachedContentTokenCount` → cacheReadInputTokens
 *     (with `inputTokens` reported as the *uncached* remainder so the cost
 *     model isn't double-counting against `pricing.ts`).
 *   - StopReason mapping including tool_use synthesized from a functionCall part.
 *   - Error mapping for the 5 SDK error classes + transport / abort.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// SDK mock --------------------------------------------------------------------
const h = vi.hoisted(() => {
  class MockBase extends Error {
    constructor(message: string) {
      super(message);
    }
  }
  class MockFetchError extends MockBase {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.status = status;
    }
  }
  class MockAbort extends MockBase {}
  class MockInputError extends MockBase {}
  class MockResponseError extends MockBase {}
  return {
    generateContent: vi.fn(),
    generateContentStream: vi.fn(),
    MockBase,
    MockFetchError,
    MockAbort,
    MockInputError,
    MockResponseError,
  };
});

vi.mock('@google/generative-ai', () => {
  class GoogleGenerativeAI {
    constructor(_apiKey: string) {}
    getGenerativeModel(_opts: { model: string }) {
      return {
        generateContent: h.generateContent,
        generateContentStream: h.generateContentStream,
      };
    }
  }
  return {
    GoogleGenerativeAI,
    GoogleGenerativeAIError: h.MockBase,
    GoogleGenerativeAIAbortError: h.MockAbort,
    GoogleGenerativeAIFetchError: h.MockFetchError,
    GoogleGenerativeAIRequestInputError: h.MockInputError,
    GoogleGenerativeAIResponseError: h.MockResponseError,
  };
});

// Imported AFTER the mock is registered.
import {
  GeminiProvider,
  DEFAULT_GEMINI_MODEL,
  cleanSchema,
} from './gemini.js';
import type { GenerateRequest, LlmMessage, LlmToolDef } from './index.js';
import { isTextBlock, isToolUseBlock } from './index.js';

const userMsg = (text: string): LlmMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
});

const okResponse = (overrides: Partial<{
  parts: Array<Record<string, unknown>>;
  finishReason: string;
  usageMetadata: Record<string, unknown>;
  modelVersion: string;
}> = {}) => ({
  response: {
    candidates: [
      {
        content: {
          parts: overrides.parts ?? [{ text: 'hello back' }],
        },
        finishReason: overrides.finishReason ?? 'STOP',
      },
    ],
    usageMetadata: overrides.usageMetadata ?? {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      cachedContentTokenCount: 0,
    },
    modelVersion: overrides.modelVersion ?? 'gemini-2.5-flash-002',
  },
});

beforeEach(() => {
  h.generateContent.mockReset();
  h.generateContentStream.mockReset();
});

// -- cleanSchema --------------------------------------------------------------

describe('cleanSchema', () => {
  it('upper-cases type and recurses into properties + items', () => {
    const s = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
    };
    expect(cleanSchema(s)).toEqual({
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING' },
        tags: { type: 'ARRAY', items: { type: 'STRING' } },
      },
      required: ['name'],
    });
  });

  it('strips $schema / additionalProperties / default / examples / title', () => {
    const s = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: 'X',
      type: 'object',
      additionalProperties: false,
      properties: { a: { type: 'string', default: 'hi', examples: ['hi'] } },
    };
    expect(cleanSchema(s)).toEqual({
      type: 'OBJECT',
      properties: { a: { type: 'STRING' } },
    });
  });

  it('translates a nullable union to type + nullable:true', () => {
    expect(cleanSchema({ type: ['string', 'null'] })).toEqual({
      type: 'STRING',
      nullable: true,
    });
  });

  it('falls back to STRING for a true union (Gemini cannot represent oneOf)', () => {
    expect(cleanSchema({ type: ['string', 'number'] })).toEqual({
      type: 'STRING',
    });
  });

  it('passes through enum + description + format unchanged', () => {
    const s = {
      type: 'string',
      enum: ['a', 'b'],
      description: 'one of a/b',
      format: 'enum',
    };
    expect(cleanSchema(s)).toEqual({
      type: 'STRING',
      enum: ['a', 'b'],
      description: 'one of a/b',
      format: 'enum',
    });
  });
});

// -- construction -------------------------------------------------------------

describe('GeminiProvider construction', () => {
  it('uses an explicit apiKey', () => {
    const p = new GeminiProvider({ apiKey: 'k' });
    expect(p.name).toBe('gemini');
  });

  it('falls back to GOOGLE_GEMINI_API_KEY env', () => {
    const prev = process.env.GOOGLE_GEMINI_API_KEY;
    process.env.GOOGLE_GEMINI_API_KEY = 'env-k';
    try {
      const p = new GeminiProvider();
      expect(p.name).toBe('gemini');
    } finally {
      if (prev === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
      else process.env.GOOGLE_GEMINI_API_KEY = prev;
    }
  });

  it('throws a clear error when no key is available', () => {
    const prev = process.env.GOOGLE_GEMINI_API_KEY;
    delete process.env.GOOGLE_GEMINI_API_KEY;
    try {
      expect(() => new GeminiProvider()).toThrow(/GOOGLE_GEMINI_API_KEY/);
    } finally {
      if (prev !== undefined) process.env.GOOGLE_GEMINI_API_KEY = prev;
    }
  });

  it('exports DEFAULT_GEMINI_MODEL = gemini-2.5-flash (priced in MODEL_PRICES)', () => {
    expect(DEFAULT_GEMINI_MODEL).toBe('gemini-2.5-flash');
  });
});

// -- generate: request shaping ------------------------------------------------

describe('GeminiProvider.generate — request shaping', () => {
  it('sends contents + generationConfig.maxOutputTokens', async () => {
    h.generateContent.mockResolvedValueOnce(okResponse());
    const p = new GeminiProvider({ apiKey: 'k', maxTokens: 1234 });
    const res = await p.generate({ messages: [userMsg('hi')] });
    expect(res.ok).toBe(true);
    const body = h.generateContent.mock.calls[0][0] as Record<string, unknown>;
    expect(
      (body.generationConfig as Record<string, unknown>).maxOutputTokens,
    ).toBe(1234);
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
    ]);
  });

  it('collapses the harness `system` array (with cacheControl markers) into systemInstruction', async () => {
    h.generateContent.mockResolvedValueOnce(okResponse());
    const p = new GeminiProvider({ apiKey: 'k' });
    const req: GenerateRequest = {
      system: [
        { type: 'text', text: 'persona', cacheControl: { type: 'ephemeral' } },
        { type: 'text', text: 'volatile' },
      ],
      messages: [userMsg('go')],
    };
    await p.generate(req);
    const body = h.generateContent.mock.calls[0][0] as Record<string, unknown>;
    // cache_control marker is silently dropped — Gemini has no per-block API.
    expect(body.systemInstruction).toEqual({
      role: 'system',
      parts: [{ text: 'persona\n\nvolatile' }],
    });
  });

  it('translates tool defs via cleanSchema into a single functionDeclarations tool', async () => {
    h.generateContent.mockResolvedValueOnce(okResponse());
    const tool: LlmToolDef = {
      name: 'look',
      description: 'observe',
      inputSchema: {
        $schema: 'x',
        type: 'object',
        additionalProperties: false,
        properties: { radius: { type: 'number' } },
        required: [],
      },
      cacheControl: { type: 'ephemeral' },
    };
    const p = new GeminiProvider({ apiKey: 'k' });
    await p.generate({ messages: [userMsg('look')], tools: [tool] });
    const body = h.generateContent.mock.calls[0][0] as Record<string, unknown>;
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'look',
            description: 'observe',
            parameters: {
              type: 'OBJECT',
              properties: { radius: { type: 'NUMBER' } },
              required: [],
            },
          },
        ],
      },
    ]);
  });

  it('maps tool_use and tool_result blocks to functionCall / functionResponse parts', async () => {
    h.generateContent.mockResolvedValueOnce(okResponse());
    const p = new GeminiProvider({ apiKey: 'k' });
    const req: GenerateRequest = {
      messages: [
        userMsg('please look'),
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'looking' },
            { type: 'tool_use', id: 'tu_1', name: 'look', input: { radius: 3 } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolUseId: 'tu_1',
              content: '{"entities":[]}',
              isError: false,
            },
          ],
        },
      ],
    };
    await p.generate(req);
    const body = h.generateContent.mock.calls[0][0] as Record<string, unknown>;
    const contents = body.contents as Array<{ role: string; parts: unknown[] }>;
    expect(contents[1]).toEqual({
      role: 'model',
      parts: [
        { text: 'looking' },
        { functionCall: { name: 'look', args: { radius: 3 } } },
      ],
    });
    expect(contents[2]).toEqual({
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'tu_1',
            response: { entities: [] },
          },
        },
      ],
    });
  });

  it('passes temperature and abort signal through', async () => {
    h.generateContent.mockResolvedValueOnce(okResponse());
    const ac = new AbortController();
    const p = new GeminiProvider({ apiKey: 'k' });
    await p.generate({
      messages: [userMsg('x')],
      temperature: 0.2,
      signal: ac.signal,
    });
    const body = h.generateContent.mock.calls[0][0] as Record<string, unknown>;
    expect(
      (body.generationConfig as Record<string, unknown>).temperature,
    ).toBe(0.2);
    const opts = h.generateContent.mock.calls[0][1] as
      | { signal?: AbortSignal }
      | undefined;
    expect(opts?.signal).toBe(ac.signal);
  });
});

// -- generate: response translation ------------------------------------------

describe('GeminiProvider.generate — response translation', () => {
  it('synthesizes stopReason=tool_use when a functionCall part is present', async () => {
    h.generateContent.mockResolvedValueOnce(
      okResponse({
        parts: [{ functionCall: { name: 'look', args: { r: 1 } } }],
        finishReason: 'STOP',
      }),
    );
    const p = new GeminiProvider({ apiKey: 'k' });
    const res = await p.generate({ messages: [userMsg('look')] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.stopReason).toBe('tool_use');
    const tu = res.value.content.find(isToolUseBlock);
    expect(tu?.name).toBe('look');
    expect(tu?.input).toEqual({ r: 1 });
  });

  it('maps MAX_TOKENS finishReason', async () => {
    h.generateContent.mockResolvedValueOnce(
      okResponse({ finishReason: 'MAX_TOKENS' }),
    );
    const p = new GeminiProvider({ apiKey: 'k' });
    const res = await p.generate({ messages: [userMsg('x')] });
    expect(res.ok && res.value.stopReason).toBe('max_tokens');
  });

  it('reports usage with cachedContentTokenCount → cacheReadInputTokens', async () => {
    h.generateContent.mockResolvedValueOnce(
      okResponse({
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 20,
          cachedContentTokenCount: 78,
        },
      }),
    );
    const p = new GeminiProvider({ apiKey: 'k' });
    const res = await p.generate({ messages: [userMsg('x')] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // input = prompt − cached, so the cost model isn't double-counting.
    expect(res.value.usage).toEqual({
      inputTokens: 22,
      outputTokens: 20,
      cacheReadInputTokens: 78,
      cacheCreationInputTokens: 0,
    });
  });

  it('returns text content from a text part', async () => {
    h.generateContent.mockResolvedValueOnce(okResponse());
    const p = new GeminiProvider({ apiKey: 'k' });
    const res = await p.generate({ messages: [userMsg('hi')] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const txt = res.value.content.find(isTextBlock);
    expect(txt?.text).toBe('hello back');
    expect(res.value.model).toBe('gemini-2.5-flash-002');
  });

  it('returns invalid_response when the SDK gives no candidates/usage', async () => {
    h.generateContent.mockResolvedValueOnce({ response: null });
    const p = new GeminiProvider({ apiKey: 'k' });
    const res = await p.generate({ messages: [userMsg('x')] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_response');
  });
});

// -- generate: error mapping --------------------------------------------------

describe('GeminiProvider.generate — error mapping (never throws)', () => {
  it('maps a 401 fetch error to non-retryable unauthorized', async () => {
    h.generateContent.mockRejectedValueOnce(
      new h.MockFetchError('bad key', 401),
    );
    const p = new GeminiProvider({ apiKey: 'k' });
    const res = await p.generate({ messages: [userMsg('x')] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('unauthorized');
    expect(res.error.retryable).toBe(false);
  });

  it('maps a 429 fetch error to retryable rate_limit', async () => {
    h.generateContent.mockRejectedValueOnce(
      new h.MockFetchError('slow', 429),
    );
    const p = new GeminiProvider({ apiKey: 'k' });
    const res = await p.generate({ messages: [userMsg('x')] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('rate_limit');
    expect(res.error.retryable).toBe(true);
  });

  it('maps a 5xx fetch error to retryable overloaded', async () => {
    h.generateContent.mockRejectedValueOnce(
      new h.MockFetchError('boom', 503),
    );
    const p = new GeminiProvider({ apiKey: 'k' });
    const res = await p.generate({ messages: [userMsg('x')] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('overloaded');
    expect(res.error.retryable).toBe(true);
  });

  it('maps an input-error to non-retryable invalid_request', async () => {
    h.generateContent.mockRejectedValueOnce(new h.MockInputError('bad body'));
    const p = new GeminiProvider({ apiKey: 'k' });
    const res = await p.generate({ messages: [userMsg('x')] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_request');
    expect(res.error.retryable).toBe(false);
  });

  it('maps an abort to non-retryable aborted', async () => {
    h.generateContent.mockRejectedValueOnce(new h.MockAbort('aborted'));
    const p = new GeminiProvider({ apiKey: 'k' });
    const res = await p.generate({ messages: [userMsg('x')] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('aborted');
    expect(res.error.retryable).toBe(false);
  });

  it('maps a response-error to invalid_response', async () => {
    h.generateContent.mockRejectedValueOnce(
      new h.MockResponseError('blocked'),
    );
    const p = new GeminiProvider({ apiKey: 'k' });
    const res = await p.generate({ messages: [userMsg('x')] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_response');
  });

  it('falls back to transport for a plain Error', async () => {
    h.generateContent.mockRejectedValueOnce(new Error('ECONNRESET'));
    const p = new GeminiProvider({ apiKey: 'k' });
    const res = await p.generate({ messages: [userMsg('x')] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('transport');
    expect(res.error.retryable).toBe(true);
  });
});

// -- streamGenerate -----------------------------------------------------------

describe('GeminiProvider.streamGenerate', () => {
  it('yields text deltas then a terminal result with usage', async () => {
    async function* chunks() {
      yield {
        candidates: [
          {
            content: { parts: [{ text: 'Hel' }] },
          },
        ],
      };
      yield {
        candidates: [
          {
            content: { parts: [{ text: 'lo' }] },
          },
        ],
      };
    }
    h.generateContentStream.mockResolvedValueOnce({
      stream: chunks(),
      response: Promise.resolve({
        candidates: [
          {
            content: { parts: [{ text: 'ignored aggregated' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 12,
          candidatesTokenCount: 4,
          cachedContentTokenCount: 3,
        },
        modelVersion: 'gemini-2.5-flash-002',
      }),
    });
    const p = new GeminiProvider({ apiKey: 'k' });
    const deltas: string[] = [];
    let final;
    for await (const ev of p.streamGenerate({ messages: [userMsg('hi')] })) {
      if (ev.type === 'text_delta') deltas.push(ev.text);
      if (ev.type === 'result') final = ev.result;
    }
    expect(deltas.join('')).toBe('Hello');
    expect(final?.stopReason).toBe('end_turn');
    const txt = final?.content.find(isTextBlock);
    expect(txt?.text).toBe('Hello');
    expect(final?.usage).toEqual({
      inputTokens: 9,
      outputTokens: 4,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 0,
    });
  });

  it('emits a typed error event on stream open failure instead of throwing', async () => {
    h.generateContentStream.mockRejectedValueOnce(
      new h.MockFetchError('429', 429),
    );
    const p = new GeminiProvider({ apiKey: 'k' });
    const events = [];
    for await (const ev of p.streamGenerate({ messages: [userMsg('x')] })) {
      events.push(ev);
    }
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    if (err?.type === 'error') expect(err.error.kind).toBe('rate_limit');
  });
});
