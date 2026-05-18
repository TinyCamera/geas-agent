/**
 * Live-gated AnthropicProvider integration test.
 *
 * Skipped unless `ANTHROPIC_API_KEY` is set (CI stays green without a key).
 * Run it explicitly:
 *
 *   ANTHROPIC_API_KEY=sk-ant-... npx vitest run --config vitest.integration.config.ts
 *
 * What it proves (issue #610 acceptance):
 *   1. A real `messages` tool-call turn drives the #609 interface end to end —
 *      we hand the model a tool and a prompt that should make it call the tool.
 *   2. Prompt caching works: a large cache-marked system prefix is sent twice;
 *      the 2nd identical-prefix call reports `cacheReadInputTokens > 0`.
 *
 * The cacheable prefix must clear Anthropic's minimum cacheable token floor,
 * so we pad the system prompt with stable filler text.
 */

import { describe, it, expect } from 'vitest';
import { AnthropicProvider } from '../../src/llm/index.js';
import type { GenerateRequest, LlmToolDef } from '../../src/llm/index.js';
import { isToolUseBlock } from '../../src/llm/index.js';

const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;
const liveDescribe = HAS_KEY ? describe : describe.skip;

// ~1.5k tokens of stable filler so the cached prefix exceeds Anthropic's
// minimum cacheable size for Haiku. Content is irrelevant — only stability is.
const STABLE_PREFIX = (
  'You are a deterministic test fixture for the Geas agent harness. '.repeat(60) +
  'Always answer concisely. '.repeat(60)
).trim();

const GET_WEATHER: LlmToolDef = {
  name: 'get_weather',
  description: 'Get the current weather for a city. Always call this tool when asked about weather.',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
};

liveDescribe('AnthropicProvider against the real Anthropic API', () => {
  it('drives a tool-call turn through the #609 interface', async () => {
    const p = new AnthropicProvider({ maxTokens: 256 });
    const req: GenerateRequest = {
      system: [{ type: 'text', text: 'You are a helpful weather assistant.' }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: "What's the weather in Paris?" }] },
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
    expect(res.value.usage.inputTokens).toBeGreaterThan(0);
    expect(res.value.model).toMatch(/haiku/);
  }, 30_000);

  it('reports a cache read on a 2nd identical cache-marked prefix', async () => {
    const p = new AnthropicProvider({ maxTokens: 16 });
    const mkReq = (q: string): GenerateRequest => ({
      system: [{ type: 'text', text: STABLE_PREFIX, cacheControl: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: q }] }],
    });

    const first = await p.generate(mkReq('Say "one".'));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // First call writes the cache (creation > 0, read may be 0).
    expect(
      first.value.usage.cacheCreationInputTokens + first.value.usage.cacheReadInputTokens,
    ).toBeGreaterThan(0);

    const second = await p.generate(mkReq('Say "two".'));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.usage.cacheReadInputTokens).toBeGreaterThan(0);
  }, 30_000);
});
