/**
 * Per-model price sheet + cost computation (#612, parent #584).
 *
 * **Why a price table here and not in the provider.** Cost is a cross-provider
 * concern: #585's product-viability gate is `$/active-character-hour`, and that
 * number is only honest if cache reads are priced ~10x cheaper than uncached
 * input (the dominant cost lever — see `cache.ts`). The provider's job is to
 * report the four token counts (`LlmUsage`); turning those into dollars is a
 * pricing-policy decision that belongs in one place so a model swap or a vendor
 * price change is a single-file edit.
 *
 * **Prices are USD per *million* tokens**, matching how Anthropic / Google
 * publish them, so the table reads like the public price sheet and is trivial
 * to audit. `cacheWrite` is the one-time cache-creation premium (Anthropic:
 * 1.25x base input for 5-min ephemeral); `cacheRead` is the cached-hit rate
 * (Anthropic: 0.1x base input).
 *
 * Unknown models are **not** silently free — `computeCostUsd` flags them so a
 * telemetry consumer can surface "we shipped a model with no price row" instead
 * of reporting $0 and passing the viability gate by accident.
 */

import type { LlmUsage } from './provider.js';

/** USD per 1,000,000 tokens for one model. */
export interface ModelPrice {
  /** Uncached input tokens. */
  readonly inputPerMTok: number;
  /** Output tokens. */
  readonly outputPerMTok: number;
  /** Cache *read* (a cached-prefix hit) — Anthropic ≈ 0.1x input. */
  readonly cacheReadPerMTok: number;
  /** Cache *write* (one-time creation premium) — Anthropic ≈ 1.25x input. */
  readonly cacheWritePerMTok: number;
}

/**
 * Published list prices, USD / MTok. Sources (2026-05, public price sheets):
 *
 *   - Anthropic Claude Haiku 4.5 — the #585 benchmark winner / first ship.
 *     $1 in, $5 out; ephemeral cache write $1.25, cache read $0.10.
 *   - Anthropic Claude Sonnet 4.5 — kept for the "is the cheap model actually
 *     cheap enough vs. the good one" comparison #585 leaves open.
 *   - Gemini Flash 2.5 — the only candidate that plausibly clears the
 *     <$0.01/hr product-viable bar; implicit caching, read ≈ 0.25x input.
 *
 * Keyed by the *resolved* model id the provider reports back in
 * `GenerateResult.model` where possible, with the alias also mapped so a
 * request that asks for `claude-haiku-4-5` still prices before the first
 * response resolves the snapshot id.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  // Anthropic Haiku 4.5 (alias + snapshot).
  'claude-haiku-4-5': {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
  },
  'claude-haiku-4-5-20251001': {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
  },
  // Anthropic Sonnet 4.5 (alias + snapshot).
  'claude-sonnet-4-5': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
  },
  'claude-sonnet-4-5-20250929': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
  },
  // Google Gemini Flash 2.5.
  'gemini-2.5-flash': {
    inputPerMTok: 0.3,
    outputPerMTok: 2.5,
    cacheReadPerMTok: 0.075,
    cacheWritePerMTok: 0.3833,
  },
};

const PER_MTOK = 1_000_000;

export interface CostBreakdownUsd {
  /** Cost of uncached input tokens. */
  readonly input: number;
  /** Cost of output tokens. */
  readonly output: number;
  /** Cost of cache-read (hit) tokens. */
  readonly cacheRead: number;
  /** Cost of cache-creation (write) tokens. */
  readonly cacheWrite: number;
  /** Sum of the four above. */
  readonly total: number;
  /**
   * True when no price row matched `model` — `total` is then `0` but the
   * caller MUST treat the figure as unknown, not free. Telemetry surfaces this
   * so an unpriced model can't quietly pass the viability gate.
   */
  readonly priced: boolean;
}

/**
 * Look up the price row for a model id. Exact match only — we deliberately do
 * not fuzzy-match (`claude-haiku-*`) so a new snapshot with a different price
 * forces a conscious table edit rather than inheriting a stale rate.
 */
export function priceFor(model: string | undefined): ModelPrice | undefined {
  if (!model) return undefined;
  return MODEL_PRICES[model];
}

/**
 * Compute the USD cost of one call from its {@link LlmUsage} and model id.
 *
 * `inputTokens` from the Anthropic wire is the *uncached* count (cache read /
 * creation are reported separately), so the four token buckets are disjoint
 * and we price each at its own rate and sum — no double counting.
 */
export function computeCostUsd(
  model: string | undefined,
  usage: LlmUsage,
): CostBreakdownUsd {
  const price = priceFor(model);
  if (!price) {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      priced: false,
    };
  }
  const input = (usage.inputTokens * price.inputPerMTok) / PER_MTOK;
  const output = (usage.outputTokens * price.outputPerMTok) / PER_MTOK;
  const cacheRead =
    (usage.cacheReadInputTokens * price.cacheReadPerMTok) / PER_MTOK;
  const cacheWrite =
    (usage.cacheCreationInputTokens * price.cacheWritePerMTok) / PER_MTOK;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    priced: true,
  };
}
