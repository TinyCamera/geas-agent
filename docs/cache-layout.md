# Prompt cache layout

Prompt caching is the dominant cost lever for the agent harness. The
[#585 benchmark](https://github.com/tinycamera/geas-server/issues/585) found
that on the *naïve* protocol (no explicit cache control) both cached Haiku 4.5
and Gemini Flash 2.5 miss Niall's product-viability gate of **<$0.05 per
active-character-hour** — by 2-12× depending on pacing — because 80%+ of input
is repeated every turn (system prompt + tool definitions). Getting the cache
breakpoints right is therefore a first-class, *asserted* behavior, not an
incidental optimization.

This is why the request type is Anthropic-shaped with explicit
`cache_control` markers (#609), the `AnthropicProvider` passes them straight
through to the wire (#610), and a single helper —
[`src/llm/cache.ts`](../src/llm/cache.ts) `buildCachedRequest()` — owns *where*
the breakpoints go (#611). The agent loop never hand-places a marker; it hands
raw inputs to the helper.

## Anthropic caching model (the rules the helper encodes)

- A `cache_control` marker caches the prefix **up to and including** the
  marked element, walking the request in the fixed concatenation order
  **`tools` → `system` → `messages`**. One marker on the *last* element of a
  contiguous stable region caches that **whole region** — you do not mark
  every block.
- **At most 4 breakpoints** per request (Anthropic hard limit, exported as
  `MAX_CACHE_BREAKPOINTS`). The helper spends at most **3**, leaving headroom
  so a caller-side merge can never trip a 400.
- A cached segment must clear a model-specific minimum (~1024 tokens for
  Haiku). The helper does not token-count; it only ever marks large,
  naturally-stable regions that clear the floor in practice. A too-small
  segment simply won't cache-hit — a cost no-op, not an error.

## The three cacheable regions

Ordered most-stable first, which is also the cache-walk order:

| # | Region | Source field | Breakpoint | Rationale |
|---|--------|--------------|------------|-----------|
| 1 | **Tool definitions** | `tools` | last tool def | Largest (~3-4k tokens for the full Geas MCP set per #585) and never change within a session. |
| 2 | **System persona** | `systemPrompt` | the single stable system block | Stable instructions / build guidance for the life of the session. |
| 3 | **Stable game-state prefix** | `stableGameState` | leading block of the first user turn | Slow-moving facts (character sheet, allocated build, current chunk/biome) — true for many turns. |

Everything else is **volatile by construction and never marked**:

- `volatileSystemSuffix` — per-turn system text (clock, ephemeral directives).
  Placed *after* the system breakpoint so it never invalidates the cached
  persona.
- The live conversation in `messages` — tool calls, tool results, this turn's
  observation. The stable game-state block is spliced *ahead* of the volatile
  turn content so the per-turn `look`/`status` churn stays uncached behind it.

## What invalidates a cache entry

Anything *before or at* a breakpoint changing busts that breakpoint and every
one after it (prefix caching). So:

- Changing the system persona → re-creates system + game-state caches.
- Adding/removing/reordering a tool → re-creates **all** caches (tools are
  first in the walk).
- Game-state prefix changing (e.g. the character leveled, allocated stats,
  moved chunks) → re-creates only the game-state cache; tools + system survive.

Keep the game-state prefix to facts that genuinely hold for many turns. Volatile
per-turn observation must stay in the conversation body, never the prefix.

## Telemetry

`AnthropicProvider` surfaces the cache split verbatim in `LlmUsage`
(`cacheReadInputTokens` / `cacheCreationInputTokens`) so #585's cost model
stays honest. `countCacheBreakpoints(req)` is available for a runtime
assertion / telemetry counter at the call site.

## Verification

- Unit: `src/llm/cache.test.ts` asserts breakpoint *placement policy*
  (last tool, single system block, prepended game-state, ≤4 ceiling).
- Live (acceptance, #611): `tests/integration/cache-layout.live.test.ts` —
  opt-in, gated on `ANTHROPIC_API_KEY`. A repeated stable prefix produces
  `cacheReadInputTokens > 0` on the 2nd turn against the real API
  (usage-based, not a mock). Run with:

  ```bash
  ANTHROPIC_API_KEY=sk-ant-... npx vitest run --config vitest.integration.config.ts
  ```

## Gemini caching (#734)

The second `LlmProvider` impl, `GeminiProvider`, has **no per-request
cache-breakpoint API**. Gemini Flash 2.5 caches implicitly — the
[#585 spike](https://github.com/tinycamera/geas-server/issues/585) observed
~78% hit rate on stable prefixes with no configuration on our side.

What this means for the cache-layout helper:

- `buildCachedRequest(...)` is a **no-op for Gemini in the cache-marker
  sense** — the `cache_control` markers it places on the system prompt, the
  last tool def, and the stable game-state prefix ride along on the request
  type but the Gemini adapter silently drops them. They don't error; they
  also don't change cache behavior. Keep using the helper anyway: the prefix
  *ordering* it enforces (tools → stable system → stable game-state →
  volatile turn content) is exactly the ordering Gemini's implicit cache
  needs to maximise hit rate.
- Cache hits surface as `LlmUsage.cacheReadInputTokens` from Gemini's
  `cachedContentTokenCount`, with `inputTokens` reported as the uncached
  remainder (so `pricing.ts` doesn't double-count against the
  `gemini-2.5-flash` row).
- `cacheCreationInputTokens` is **always 0** for Gemini — implicit caching is
  free to write. The cost model handles that correctly.
