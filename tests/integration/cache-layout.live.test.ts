/**
 * Live-gated acceptance test for the #611 cache-layout helper.
 *
 * Skipped unless `ANTHROPIC_API_KEY` is set (CI stays green without a key):
 *
 *   ANTHROPIC_API_KEY=sk-ant-... npx vitest run --config vitest.integration.config.ts
 *
 * What it proves (issue #611 acceptance — "a repeated-prefix sequence produces
 * cache reads; usage-based assertion, not a mock"): two turns built *only*
 * through `buildCachedRequest` with the same stable system + tool defs +
 * game-state prefix and a differing volatile tail. The 2nd call must report
 * `cacheReadInputTokens > 0` — i.e. the helper placed the breakpoints somewhere
 * the real Anthropic cache could hit. anthropic.test.ts already proves the
 * marker→`cache_control` wire mapping; this proves the *policy* pays off.
 */

import { describe, it, expect } from 'vitest';
import { AnthropicProvider, buildCachedRequest } from '../../src/llm/index.js';
import type { LlmToolDef } from '../../src/llm/index.js';

const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;
const liveDescribe = HAS_KEY ? describe : describe.skip;

// Stable, large enough to clear Haiku's ~1024-token minimum cacheable size.
const STABLE_SYSTEM = (
  'You are the otherworldly guide bound to a Geas character. ' +
  'Play efficiently: observe, then act toward leveling up. '.repeat(40)
).trim();

const STABLE_GAME_STATE =
  'CHARACTER SHEET: Level 3 fighter. STR 9, AGI 5, INT 2, CHA 3. ' +
  'Skills: power-strike, guard. Current chunk (0,0), forest biome. '.repeat(20);

// A few sizeable tool defs so the cached tool block is non-trivial.
const TOOLS: Omit<LlmToolDef, 'cacheControl'>[] = Array.from(
  { length: 6 },
  (_, i) => ({
    name: `tool_${i}`,
    description:
      `Geas MCP tool number ${i}. ` +
      'It accepts a structured argument object and returns world state. '.repeat(8),
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'entity id or coords' } },
    },
  }),
);

liveDescribe('buildCachedRequest against the real Anthropic API', () => {
  it('a repeated stable prefix produces a cache read on the 2nd turn', async () => {
    const p = new AnthropicProvider({ maxTokens: 16 });

    const mk = (turn: string) =>
      buildCachedRequest({
        systemPrompt: STABLE_SYSTEM,
        volatileSystemSuffix: `Volatile clock: ${turn}`,
        stableGameState: STABLE_GAME_STATE,
        tools: TOOLS,
        messages: [{ role: 'user', content: [{ type: 'text', text: turn }] }],
      });

    const first = await p.generate(mk('Say "one".'));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // First call writes the cache.
    expect(
      first.value.usage.cacheCreationInputTokens +
        first.value.usage.cacheReadInputTokens,
    ).toBeGreaterThan(0);

    const second = await p.generate(mk('Say "two".'));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Stable system + tools + game-state prefix were identical → cache hit.
    expect(second.value.usage.cacheReadInputTokens).toBeGreaterThan(0);
  }, 30_000);
});
