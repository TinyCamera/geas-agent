/**
 * Cache-layout helper — assembles a {@link GenerateRequest} with prompt-cache
 * breakpoints placed where they actually pay off (#611, parent #584).
 *
 * **Why this exists separately from the provider.** #609 defined the marker
 * types (`cacheControl` on text blocks / tool defs) and #610 wired the
 * AnthropicProvider to pass them through as `cache_control`. Neither *decides*
 * where the breakpoints go — that's a policy call, and getting it wrong is the
 * dominant cost lever (#585: on the naïve protocol cached Haiku/Flash both
 * miss Niall's <$0.05/active-hr gate; tool defs + system prompt are ~80%+ of
 * repeated input). This module is the one place that policy lives, so the
 * agent loop just calls `buildCachedRequest(...)` and never hand-places a
 * marker.
 *
 * **Anthropic caching model (the rules this encodes).**
 *
 *   - A `cache_control` marker caches the prefix *up to and including* the
 *     marked element, walking the request in the fixed concatenation order
 *     `tools` → `system` → `messages`. So one marker on the *last* element of
 *     a contiguous stable region caches that whole region — you do **not**
 *     mark every block.
 *   - At most **4** breakpoints per request (Anthropic hard limit). We spend
 *     at most 3: tool defs, system persona, stable game-state prefix — leaving
 *     headroom and never risking a 400.
 *   - A cached segment must clear a model-specific minimum token floor
 *     (~1024 for Haiku). We can't cheaply count tokens here, so we don't try
 *     to gate on size — we only ever mark large, naturally-stable regions
 *     (the full tool block, the persona, the character/world prefix) which in
 *     practice clear the floor; tiny segments simply won't cache-hit, which is
 *     a no-op cost-wise, not an error.
 *
 * **The three cacheable regions, most-stable first (= cache-hierarchy order).**
 *
 *   1. **Tool definitions** — largest and never change within a session
 *     (~3-4k tokens for the full Geas MCP tool set per #585). One breakpoint
 *     on the last tool caches all of them.
 *   2. **System persona** — stable instructions / build guidance. Cached.
 *     Anything that changes per turn (e.g. "it is turn 42") goes in
 *     `volatileSystemSuffix`, *after* the breakpoint, uncached.
 *   3. **Stable game-state prefix** — facts that hold for many turns
 *     (character sheet, allocated build, current chunk/biome) prepended as a
 *     cached leading block on the first user turn. The per-turn observation
 *     churn (`look`/`status` deltas) stays *after* it, uncached.
 *
 * Everything else — the live conversation, tool results, this turn's
 * observation — is volatile by construction and never marked.
 */

import type {
  GenerateRequest,
  LlmMessage,
  LlmToolDef,
  TextBlock,
} from './provider.js';

/** Anthropic's hard limit on `cache_control` breakpoints per request. */
export const MAX_CACHE_BREAKPOINTS = 4;

const EPHEMERAL = { type: 'ephemeral' as const };

export interface BuildCachedRequestInput {
  /**
   * Stable system instructions (persona, build guidance, rules). Cached as a
   * single block. This is the part that does not change for the life of the
   * session.
   */
  readonly systemPrompt: string;
  /**
   * Optional system text that changes per turn (clock, ephemeral directives).
   * Placed *after* the system cache breakpoint so it never invalidates the
   * cached persona.
   */
  readonly volatileSystemSuffix?: string;
  /**
   * Optional slow-moving game state (character sheet, allocated build,
   * current chunk/biome) — true for many turns. Prepended as a cached leading
   * block on the first user turn, ahead of the volatile per-turn observation.
   */
  readonly stableGameState?: string;
  /**
   * MCP tool definitions. The full set is large and session-stable; the last
   * one gets the breakpoint so the whole block caches.
   */
  readonly tools?: readonly Omit<LlmToolDef, 'cacheControl'>[];
  /** The live conversation. Never marked — volatile by construction. */
  readonly messages: readonly LlmMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

function buildSystem(input: BuildCachedRequestInput): readonly TextBlock[] {
  const blocks: TextBlock[] = [
    { type: 'text', text: input.systemPrompt, cacheControl: EPHEMERAL },
  ];
  if (input.volatileSystemSuffix) {
    blocks.push({ type: 'text', text: input.volatileSystemSuffix });
  }
  return blocks;
}

function buildTools(
  input: BuildCachedRequestInput,
): readonly LlmToolDef[] | undefined {
  const tools = input.tools;
  if (!tools || tools.length === 0) return undefined;
  const lastIdx = tools.length - 1;
  return tools.map((t, i) =>
    i === lastIdx ? { ...t, cacheControl: EPHEMERAL } : { ...t },
  );
}

/**
 * Prepend the stable game-state block ahead of the volatile turn content.
 * If the conversation already opens with a user turn we splice the cached
 * block in front of its content; otherwise (conversation starts with an
 * assistant turn — unusual but legal) we insert a fresh leading user turn so
 * the cached prefix still sits at the front, where the cache walk reaches it.
 */
function buildMessages(
  input: BuildCachedRequestInput,
): readonly LlmMessage[] {
  const { messages, stableGameState } = input;
  if (!stableGameState) return messages;

  const cachedBlock: TextBlock = {
    type: 'text',
    text: stableGameState,
    cacheControl: EPHEMERAL,
  };

  const first = messages[0];
  if (first && first.role === 'user') {
    const rest = messages.slice(1);
    return [
      { role: 'user', content: [cachedBlock, ...first.content] },
      ...rest,
    ];
  }
  return [{ role: 'user', content: [cachedBlock] }, ...messages];
}

/**
 * Assemble a cache-optimized {@link GenerateRequest}. The agent loop builds
 * its raw inputs (system text, MCP tool list, game state, conversation) and
 * hands them here — breakpoint placement is entirely this function's job.
 */
export function buildCachedRequest(
  input: BuildCachedRequestInput,
): GenerateRequest {
  return {
    system: buildSystem(input),
    tools: buildTools(input),
    messages: buildMessages(input),
    maxTokens: input.maxTokens,
    temperature: input.temperature,
    signal: input.signal,
  };
}

/**
 * Count the `cache_control` breakpoints a request carries. Used in tests to
 * assert we stay under {@link MAX_CACHE_BREAKPOINTS}; also handy for telemetry
 * / a runtime assertion at the call site if a caller ever hand-merges blocks.
 */
export function countCacheBreakpoints(req: GenerateRequest): number {
  let n = 0;
  for (const b of req.system ?? []) {
    if (b.cacheControl) n++;
  }
  for (const t of req.tools ?? []) {
    if (t.cacheControl) n++;
  }
  for (const m of req.messages) {
    for (const c of m.content) {
      if (c.type === 'text' && c.cacheControl) n++;
    }
  }
  return n;
}
