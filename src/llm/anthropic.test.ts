/**
 * AnthropicProvider tests.
 *
 * The Anthropic SDK is mocked at its single boundary (`messages.create`). We
 * never make a real network call here: instead we assert the *request shape*
 * the provider builds (system / tool-def / message cache_control breakpoints,
 * model id, max_tokens) and that responses + usage (including the cache
 * read/creation split) are translated back into the #609 interface types.
 *
 * A live-gated end-to-end test (real key, real cache-hit on the 2nd call)
 * lives in tests/integration/anthropic.live.test.ts and is opt-in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- SDK mock ---------------------------------------------------------------
// `vi.hoisted` lifts these above the hoisted `vi.mock` factory so the factory
// can close over them without a TDZ error.
const h = vi.hoisted(() => {
  class MockAPIError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  class MockAuthError extends MockAPIError {}
  class MockRateLimitError extends MockAPIError {}
  class MockOverloadError extends MockAPIError {}
  class MockBadRequestError extends MockAPIError {}
  class MockConnError extends Error {}
  class MockTimeoutError extends MockConnError {}
  class MockAbortError extends Error {}
  return {
    createMock: vi.fn(),
    MockAPIError,
    MockAuthError,
    MockRateLimitError,
    MockOverloadError,
    MockBadRequestError,
    MockConnError,
    MockTimeoutError,
    MockAbortError,
  };
});

const {
  createMock,
  MockAuthError,
  MockRateLimitError,
  MockOverloadError,
  MockBadRequestError,
  MockConnError,
  MockAbortError,
} = h;

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages: { create: typeof h.createMock };
    constructor(_opts: unknown) {
      this.messages = { create: h.createMock };
    }
  }
  return {
    default: Anthropic,
    Anthropic,
    APIError: h.MockAPIError,
    AuthenticationError: h.MockAuthError,
    RateLimitError: h.MockRateLimitError,
    InternalServerError: h.MockOverloadError,
    BadRequestError: h.MockBadRequestError,
    UnprocessableEntityError: h.MockBadRequestError,
    APIConnectionError: h.MockConnError,
    APIConnectionTimeoutError: h.MockTimeoutError,
    APIUserAbortError: h.MockAbortError,
  };
});

// Imported after the mock is registered.
import { AnthropicProvider } from './anthropic.js';
import type { GenerateRequest, LlmMessage, LlmToolDef } from './index.js';
import { isTextBlock, isToolUseBlock } from './index.js';

const userMsg = (text: string): LlmMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
});

const okResponse = (overrides: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-4-5-20251001',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: 'hello back' }],
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  ...overrides,
});

beforeEach(() => {
  createMock.mockReset();
});

describe('AnthropicProvider construction', () => {
  it('uses the explicit apiKey option', () => {
    const p = new AnthropicProvider({ apiKey: 'sk-test' });
    expect(p.name).toBe('anthropic');
  });

  it('falls back to ANTHROPIC_API_KEY env when no apiKey passed', () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-env';
    try {
      const p = new AnthropicProvider();
      expect(p.name).toBe('anthropic');
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it('throws a clear error when no key is available (no silent fallback)', () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => new AnthropicProvider()).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

describe('AnthropicProvider.generate — request shaping', () => {
  it('sends model, max_tokens, and a basic message turn', async () => {
    createMock.mockResolvedValueOnce(okResponse());
    const p = new AnthropicProvider({ apiKey: 'sk', maxTokens: 1234 });
    const res = await p.generate({ messages: [userMsg('hi')] });

    expect(res.ok).toBe(true);
    const body = createMock.mock.calls[0][0];
    expect(body.model).toBe('claude-haiku-4-5');
    expect(body.max_tokens).toBe(1234);
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]);
  });

  it('maps system blocks and stamps cache_control on the marked block', async () => {
    createMock.mockResolvedValueOnce(okResponse());
    const p = new AnthropicProvider({ apiKey: 'sk' });
    const req: GenerateRequest = {
      system: [
        { type: 'text', text: 'persona', cacheControl: { type: 'ephemeral' } },
        { type: 'text', text: 'volatile suffix' },
      ],
      messages: [userMsg('go')],
    };
    await p.generate(req);

    const body = createMock.mock.calls[0][0];
    expect(body.system).toEqual([
      { type: 'text', text: 'persona', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'volatile suffix' },
    ]);
  });

  it('maps tool defs with input_schema and a cache breakpoint on the marked tool', async () => {
    createMock.mockResolvedValueOnce(okResponse());
    const tool: LlmToolDef = {
      name: 'look',
      description: 'observe the world',
      inputSchema: { type: 'object', properties: {} },
      cacheControl: { type: 'ephemeral' },
    };
    const p = new AnthropicProvider({ apiKey: 'sk' });
    await p.generate({ messages: [userMsg('look')], tools: [tool] });

    const body = createMock.mock.calls[0][0];
    expect(body.tools).toEqual([
      {
        name: 'look',
        description: 'observe the world',
        input_schema: { type: 'object', properties: {} },
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });

  it('translates tool_use and tool_result blocks in the conversation', async () => {
    createMock.mockResolvedValueOnce(okResponse());
    const p = new AnthropicProvider({ apiKey: 'sk' });
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

    const body = createMock.mock.calls[0][0];
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'looking' },
        { type: 'tool_use', id: 'tu_1', name: 'look', input: { radius: 3 } },
      ],
    });
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_1',
          content: '{"entities":[]}',
          is_error: false,
        },
      ],
    });
  });

  it('passes temperature and the abort signal through', async () => {
    createMock.mockResolvedValueOnce(okResponse());
    const ac = new AbortController();
    const p = new AnthropicProvider({ apiKey: 'sk' });
    await p.generate({ messages: [userMsg('x')], temperature: 0.2, signal: ac.signal });

    const body = createMock.mock.calls[0][0];
    const opts = createMock.mock.calls[0][1];
    expect(body.temperature).toBe(0.2);
    expect(opts?.signal).toBe(ac.signal);
  });
});

describe('AnthropicProvider.generate — response translation', () => {
  it('returns a tool_use turn and the cache-split usage', async () => {
    createMock.mockResolvedValueOnce(
      okResponse({
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'calling look' },
          { type: 'tool_use', id: 'tu_9', name: 'look', input: { r: 1 } },
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 15,
        },
      }),
    );
    const p = new AnthropicProvider({ apiKey: 'sk' });
    const res = await p.generate({ messages: [userMsg('look')] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.stopReason).toBe('tool_use');
    const tu = res.value.content.find(isToolUseBlock);
    expect(tu?.name).toBe('look');
    expect(tu?.input).toEqual({ r: 1 });
    const txt = res.value.content.find(isTextBlock);
    expect(txt?.text).toBe('calling look');
    expect(res.value.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 15,
    });
    expect(res.value.model).toBe('claude-haiku-4-5-20251001');
  });

  it('treats null cache usage fields as zero', async () => {
    createMock.mockResolvedValueOnce(
      okResponse({
        usage: {
          input_tokens: 7,
          output_tokens: 2,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        },
      }),
    );
    const p = new AnthropicProvider({ apiKey: 'sk' });
    const res = await p.generate({ messages: [userMsg('hi')] });
    expect(res.ok && res.value.usage).toEqual({
      inputTokens: 7,
      outputTokens: 2,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });
});

describe('AnthropicProvider.generate — error mapping (never throws)', () => {
  it('maps a 401 to a non-retryable unauthorized Err', async () => {
    createMock.mockRejectedValueOnce(new MockAuthError(401, 'bad key'));
    const p = new AnthropicProvider({ apiKey: 'sk' });
    const res = await p.generate({ messages: [userMsg('x')] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('unauthorized');
    expect(res.error.retryable).toBe(false);
  });

  it('maps a 429 to a retryable rate_limit Err', async () => {
    createMock.mockRejectedValueOnce(new MockRateLimitError(429, 'slow down'));
    const p = new AnthropicProvider({ apiKey: 'sk' });
    const res = await p.generate({ messages: [userMsg('x')] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('rate_limit');
    expect(res.error.retryable).toBe(true);
  });

  it('maps a 5xx to a retryable overloaded Err', async () => {
    createMock.mockRejectedValueOnce(new MockOverloadError(529, 'overloaded'));
    const p = new AnthropicProvider({ apiKey: 'sk' });
    const res = await p.generate({ messages: [userMsg('x')] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('overloaded');
    expect(res.error.retryable).toBe(true);
  });

  it('maps a 400 to a non-retryable invalid_request Err', async () => {
    createMock.mockRejectedValueOnce(new MockBadRequestError(400, 'bad body'));
    const p = new AnthropicProvider({ apiKey: 'sk' });
    const res = await p.generate({ messages: [userMsg('x')] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_request');
    expect(res.error.retryable).toBe(false);
  });

  it('maps a connection failure to a retryable transport Err', async () => {
    createMock.mockRejectedValueOnce(new MockConnError('ECONNRESET'));
    const p = new AnthropicProvider({ apiKey: 'sk' });
    const res = await p.generate({ messages: [userMsg('x')] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('transport');
    expect(res.error.retryable).toBe(true);
  });

  it('maps a user abort to a non-retryable aborted Err', async () => {
    createMock.mockRejectedValueOnce(new MockAbortError('aborted'));
    const p = new AnthropicProvider({ apiKey: 'sk' });
    const res = await p.generate({ messages: [userMsg('x')] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('aborted');
    expect(res.error.retryable).toBe(false);
  });

  it('maps an unparseable response to invalid_response', async () => {
    createMock.mockResolvedValueOnce({ id: 'm', type: 'message' /* no content/usage */ });
    const p = new AnthropicProvider({ apiKey: 'sk' });
    const res = await p.generate({ messages: [userMsg('x')] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_response');
  });
});

describe('AnthropicProvider.streamGenerate', () => {
  it('yields text deltas then a terminal result with usage', async () => {
    async function* fakeStream() {
      yield { type: 'message_start', message: { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 12, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 } } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } };
      yield { type: 'message_stop' };
    }
    createMock.mockResolvedValueOnce(fakeStream());
    const p = new AnthropicProvider({ apiKey: 'sk' });

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
      inputTokens: 12,
      outputTokens: 4,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 0,
    });
    // streaming requested
    expect(createMock.mock.calls[0][0].stream).toBe(true);
  });

  it('accumulates a tool_use block from input_json deltas', async () => {
    async function* fakeStream() {
      yield { type: 'message_start', message: { model: 'm', usage: { input_tokens: 1 } } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'look', input: {} } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"r":' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '2}' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } };
      yield { type: 'message_stop' };
    }
    createMock.mockResolvedValueOnce(fakeStream());
    const p = new AnthropicProvider({ apiKey: 'sk' });

    let final;
    for await (const ev of p.streamGenerate({ messages: [userMsg('look')] })) {
      if (ev.type === 'result') final = ev.result;
    }
    expect(final?.stopReason).toBe('tool_use');
    const tu = final?.content.find(isToolUseBlock);
    expect(tu?.name).toBe('look');
    expect(tu?.input).toEqual({ r: 2 });
  });

  it('emits a typed error event on stream failure instead of throwing', async () => {
    createMock.mockRejectedValueOnce(new MockRateLimitError(429, 'too fast'));
    const p = new AnthropicProvider({ apiKey: 'sk' });
    const events = [];
    for await (const ev of p.streamGenerate({ messages: [userMsg('x')] })) {
      events.push(ev);
    }
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    if (err?.type === 'error') expect(err.error.kind).toBe('rate_limit');
  });
});
