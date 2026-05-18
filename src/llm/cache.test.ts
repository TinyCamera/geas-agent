/**
 * Tests for the cache-layout helper (`buildCachedRequest`, #611).
 *
 * These assert *breakpoint placement policy*, not the wire mapping — the
 * AnthropicProvider already owns translating `cacheControl` → `cache_control`
 * (#610, covered by anthropic.test.ts). Here we only prove the helper marks
 * the right blocks: the last tool def, the last stable system block, and the
 * stable game-state prefix — and that it never exceeds Anthropic's 4-breakpoint
 * ceiling.
 */
import { describe, it, expect } from 'vitest';
import {
  buildCachedRequest,
  countCacheBreakpoints,
  MAX_CACHE_BREAKPOINTS,
} from './cache.js';
import type { LlmMessage } from './index.js';

const toolDefs = [
  { name: 'look', description: 'observe', inputSchema: { type: 'object' } },
  { name: 'move', description: 'walk', inputSchema: { type: 'object' } },
  { name: 'act', description: 'do', inputSchema: { type: 'object' } },
];

const convo: LlmMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'turn 1: you see a goblin' }] },
];

describe('buildCachedRequest — tool defs', () => {
  it('marks exactly the last tool def (caches the whole stable tool block)', () => {
    const req = buildCachedRequest({
      systemPrompt: 'persona',
      tools: toolDefs,
      messages: convo,
    });
    expect(req.tools).toHaveLength(3);
    expect(req.tools?.[0].cacheControl).toBeUndefined();
    expect(req.tools?.[1].cacheControl).toBeUndefined();
    expect(req.tools?.[2].cacheControl).toEqual({ type: 'ephemeral' });
  });

  it('omits the tool breakpoint when there are no tools', () => {
    const req = buildCachedRequest({ systemPrompt: 'persona', messages: convo });
    expect(req.tools).toBeUndefined();
  });
});

describe('buildCachedRequest — system prompt', () => {
  it('caches a single stable system block', () => {
    const req = buildCachedRequest({
      systemPrompt: 'you are a goblin slayer',
      messages: convo,
    });
    expect(req.system).toEqual([
      { type: 'text', text: 'you are a goblin slayer', cacheControl: { type: 'ephemeral' } },
    ]);
  });

  it('caches the stable persona prefix but leaves a volatile suffix uncached', () => {
    const req = buildCachedRequest({
      systemPrompt: 'stable persona',
      volatileSystemSuffix: 'it is currently turn 42',
      messages: convo,
    });
    expect(req.system).toEqual([
      { type: 'text', text: 'stable persona', cacheControl: { type: 'ephemeral' } },
      { type: 'text', text: 'it is currently turn 42' },
    ]);
  });
});

describe('buildCachedRequest — stable game-state prefix', () => {
  it('prepends a cached game-state block ahead of the first user turn', () => {
    const req = buildCachedRequest({
      systemPrompt: 'persona',
      stableGameState: 'CHARACTER SHEET: Lv3 fighter, STR 9',
      messages: convo,
    });
    const first = req.messages[0];
    expect(first.role).toBe('user');
    expect(first.content[0]).toEqual({
      type: 'text',
      text: 'CHARACTER SHEET: Lv3 fighter, STR 9',
      cacheControl: { type: 'ephemeral' },
    });
    // the original volatile turn text follows, uncached
    expect(first.content[1]).toEqual({
      type: 'text',
      text: 'turn 1: you see a goblin',
    });
  });

  it('does not touch messages when no stable game state is given', () => {
    const req = buildCachedRequest({ systemPrompt: 'persona', messages: convo });
    expect(req.messages).toEqual(convo);
  });

  it('inserts the game-state prefix as a fresh leading user turn when the conversation starts with an assistant turn', () => {
    const startsWithAssistant: LlmMessage[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ];
    const req = buildCachedRequest({
      systemPrompt: 'persona',
      stableGameState: 'WORLD: chunk (0,0)',
      messages: startsWithAssistant,
    });
    expect(req.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'WORLD: chunk (0,0)', cacheControl: { type: 'ephemeral' } },
      ],
    });
    expect(req.messages[1]).toEqual(startsWithAssistant[0]);
  });
});

describe('buildCachedRequest — breakpoint ceiling', () => {
  it('never emits more than the Anthropic max of 4 breakpoints', () => {
    const req = buildCachedRequest({
      systemPrompt: 'persona',
      volatileSystemSuffix: 'volatile',
      stableGameState: 'state',
      tools: toolDefs,
      messages: convo,
    });
    // tools(1) + system(1) + game-state(1) = 3, well under the ceiling.
    expect(countCacheBreakpoints(req)).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
    expect(countCacheBreakpoints(req)).toBe(3);
  });

  it('exposes the ceiling as 4 (Anthropic hard limit)', () => {
    expect(MAX_CACHE_BREAKPOINTS).toBe(4);
  });
});

describe('buildCachedRequest — passthrough options', () => {
  it('threads maxTokens, temperature, and the abort signal through unchanged', () => {
    const ac = new AbortController();
    const req = buildCachedRequest({
      systemPrompt: 'persona',
      messages: convo,
      maxTokens: 512,
      temperature: 0.3,
      signal: ac.signal,
    });
    expect(req.maxTokens).toBe(512);
    expect(req.temperature).toBe(0.3);
    expect(req.signal).toBe(ac.signal);
  });
});
