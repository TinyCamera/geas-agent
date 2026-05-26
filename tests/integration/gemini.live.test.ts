/**
 * Live-gated GeminiProvider integration test (#734).
 *
 * Skipped unless `GOOGLE_GEMINI_API_KEY` is set — CI stays green without a
 * key. Run explicitly:
 *
 *   GOOGLE_GEMINI_API_KEY=... npx vitest run --config vitest.integration.config.ts
 *
 * What it proves (#734 acceptance):
 *   1. A real `generateContent` tool-call turn drives the #609 interface end
 *      to end — we hand the model a tool and a prompt that should make it
 *      call the tool, and assert we recover a typed `tool_use` block.
 *   2. Streaming round-trip produces text deltas + a terminal result with
 *      usage populated.
 */

import { describe, it, expect } from 'vitest';
import { GeminiProvider } from '../../src/llm/index.js';
import type { GenerateRequest, LlmToolDef } from '../../src/llm/index.js';
import { isToolUseBlock, isTextBlock } from '../../src/llm/index.js';

const HAS_KEY = !!process.env.GOOGLE_GEMINI_API_KEY;
const liveDescribe = HAS_KEY ? describe : describe.skip;

const GET_WEATHER: LlmToolDef = {
  name: 'get_weather',
  description:
    'Get the current weather for a city. Always call this tool when asked about weather.',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
};

liveDescribe('GeminiProvider against the real Gemini API', () => {
  it('drives a tool-call turn through the #609 interface', async () => {
    const p = new GeminiProvider({ maxTokens: 256 });
    const req: GenerateRequest = {
      system: [{ type: 'text', text: 'You are a helpful weather assistant.' }],
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: "What's the weather in Paris?" }],
        },
      ],
      tools: [GET_WEATHER],
    };
    const res = await p.generate(req);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.stopReason).toBe('tool_use');
    const tu = res.value.content.find(isToolUseBlock);
    expect(tu?.name).toBe('get_weather');
    expect(typeof (tu?.input as { city?: unknown })?.city).toBe('string');
    // Gemini bills the full prompt regardless of implicit-cache state; the
    // count is always > 0 for a non-empty request.
    expect(res.value.usage.inputTokens + res.value.usage.cacheReadInputTokens).toBeGreaterThan(0);
  }, 30_000);

  it('streams a text turn with usage on the terminal event', async () => {
    const p = new GeminiProvider({ maxTokens: 64 });
    const req: GenerateRequest = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Say the word "hello" and nothing else.' }],
        },
      ],
    };
    const deltas: string[] = [];
    let final;
    for await (const ev of p.streamGenerate(req)) {
      if (ev.type === 'text_delta') deltas.push(ev.text);
      if (ev.type === 'result') final = ev.result;
    }
    expect(final).toBeDefined();
    if (!final) return;
    const txt = final.content.find(isTextBlock);
    expect(txt?.text.toLowerCase()).toContain('hello');
    expect(final.usage.outputTokens).toBeGreaterThan(0);
  }, 30_000);
});
