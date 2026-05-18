import { describe, it, expect } from 'vitest';
import {
  NoopProvider,
  type LlmMessage,
  type LlmToolDef,
  type GenerateRequest,
  type GenerateResult,
  type LlmProvider,
  type ScriptedTurn,
  isToolUseBlock,
  isTextBlock,
} from './index.js';

const ECHO_TOOL: LlmToolDef = {
  name: 'echo',
  description: 'Echo the input back.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
};

const userMsg = (text: string): LlmMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
});

describe('LlmProvider interface', () => {
  it('NoopProvider satisfies the LlmProvider structural contract', () => {
    const p: LlmProvider = new NoopProvider();
    expect(typeof p.generate).toBe('function');
    expect(typeof p.streamGenerate).toBe('function');
    expect(p.name).toBe('noop');
  });
});

describe('NoopProvider.generate', () => {
  it('round-trips a scripted tool call', async () => {
    const script: ScriptedTurn[] = [
      {
        stopReason: 'tool_use',
        content: [
          { type: 'text', text: 'Calling echo.' },
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'echo',
            input: { text: 'hello' },
          },
        ],
      },
    ];
    const p = new NoopProvider({ script });
    const req: GenerateRequest = {
      messages: [userMsg('please echo hello')],
      tools: [ECHO_TOOL],
    };

    const res = await p.generate(req);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const out: GenerateResult = res.value;
    expect(out.stopReason).toBe('tool_use');

    const toolUse = out.content.find(isToolUseBlock);
    expect(toolUse).toBeDefined();
    expect(toolUse?.name).toBe('echo');
    expect(toolUse?.input).toEqual({ text: 'hello' });
    expect(toolUse?.id).toBe('call_1');

    const text = out.content.find(isTextBlock);
    expect(text?.text).toBe('Calling echo.');

    // Usage telemetry is always present (zeroed for the noop double).
    expect(out.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it('records each request it was asked to generate for', async () => {
    const p = new NoopProvider();
    const req: GenerateRequest = {
      system: [{ type: 'text', text: 'You are a test.', cacheControl: { type: 'ephemeral' } }],
      messages: [userMsg('hi')],
      tools: [ECHO_TOOL],
    };
    await p.generate(req);
    expect(p.requests).toHaveLength(1);
    expect(p.requests[0]).toBe(req);
  });

  it('preserves explicit cache-control markers on the request (Haiku-shaped)', async () => {
    const p = new NoopProvider();
    const req: GenerateRequest = {
      system: [
        { type: 'text', text: 'Long stable system prompt.', cacheControl: { type: 'ephemeral' } },
      ],
      messages: [userMsg('go')],
      tools: [{ ...ECHO_TOOL, cacheControl: { type: 'ephemeral' } }],
    };
    await p.generate(req);
    const seen = p.requests[0];
    expect(seen.system?.[0].cacheControl).toEqual({ type: 'ephemeral' });
    expect(seen.tools?.[0].cacheControl).toEqual({ type: 'ephemeral' });
  });

  it('defaults to an end_turn text turn when no script is supplied', async () => {
    const p = new NoopProvider();
    const res = await p.generate({ messages: [userMsg('anything')] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.stopReason).toBe('end_turn');
    expect(res.value.content.some(isTextBlock)).toBe(true);
  });

  it('replays scripted turns in order, then falls back to default', async () => {
    const p = new NoopProvider({
      script: [
        { stopReason: 'end_turn', content: [{ type: 'text', text: 'first' }] },
        { stopReason: 'end_turn', content: [{ type: 'text', text: 'second' }] },
      ],
    });
    const r1 = await p.generate({ messages: [userMsg('a')] });
    const r2 = await p.generate({ messages: [userMsg('b')] });
    const r3 = await p.generate({ messages: [userMsg('c')] });
    expect(r1.ok && r1.value.content).toEqual([{ type: 'text', text: 'first' }]);
    expect(r2.ok && r2.value.content).toEqual([{ type: 'text', text: 'second' }]);
    // exhausted -> default end_turn
    expect(r3.ok && r3.value.stopReason).toBe('end_turn');
  });

  it('surfaces a scripted error as a typed Err instead of throwing', async () => {
    const p = new NoopProvider({
      script: [{ error: { kind: 'rate_limit', message: 'slow down' } }],
    });
    const res = await p.generate({ messages: [userMsg('x')] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('rate_limit');
    expect(res.error.message).toMatch(/slow down/);
  });
});

describe('NoopProvider.streamGenerate', () => {
  it('yields text deltas then a final result event', async () => {
    const p = new NoopProvider({
      script: [
        {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: 'streamed reply' }],
        },
      ],
    });

    const events: string[] = [];
    let final: GenerateResult | undefined;
    for await (const ev of p.streamGenerate({ messages: [userMsg('stream please')] })) {
      events.push(ev.type);
      if (ev.type === 'text_delta') expect(typeof ev.text).toBe('string');
      if (ev.type === 'result') final = ev.result;
    }

    expect(events[0]).toBe('text_delta');
    expect(events.at(-1)).toBe('result');
    expect(final?.stopReason).toBe('end_turn');
    const txt = final?.content.find(isTextBlock);
    expect(txt?.text).toBe('streamed reply');
  });

  it('streams a tool_use turn as a single result event with no text deltas', async () => {
    const p = new NoopProvider({
      script: [
        {
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: 'c1', name: 'echo', input: { text: 'hi' } }],
        },
      ],
    });
    const events = [];
    for await (const ev of p.streamGenerate({ messages: [userMsg('call it')] })) {
      events.push(ev);
    }
    expect(events.filter((e) => e.type === 'text_delta')).toHaveLength(0);
    const result = events.find((e) => e.type === 'result');
    expect(result).toBeDefined();
  });

  it('emits an error event for a scripted provider error', async () => {
    const p = new NoopProvider({
      script: [{ error: { kind: 'transport', message: 'socket reset' } }],
    });
    const events = [];
    for await (const ev of p.streamGenerate({ messages: [userMsg('x')] })) {
      events.push(ev);
    }
    const errEv = events.find((e) => e.type === 'error');
    expect(errEv).toBeDefined();
    if (errEv?.type === 'error') {
      expect(errEv.error.kind).toBe('transport');
    }
  });
});
