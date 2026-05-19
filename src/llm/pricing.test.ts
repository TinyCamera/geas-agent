/**
 * Pricing tests — synthetic usage numbers → expected USD (the #612 acceptance:
 * "Unit test: synthetic usage numbers → expected $").
 *
 * The arithmetic is hand-computed against the published Haiku 4.5 sheet so a
 * future price-table edit that breaks the math fails loudly.
 */
import { describe, it, expect } from 'vitest';
import { computeCostUsd, priceFor, MODEL_PRICES } from './pricing.js';
import type { LlmUsage } from './provider.js';

const usage = (u: Partial<LlmUsage>): LlmUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  ...u,
});

describe('priceFor', () => {
  it('resolves the Haiku alias and its snapshot to the same row', () => {
    expect(priceFor('claude-haiku-4-5')).toEqual(
      priceFor('claude-haiku-4-5-20251001'),
    );
  });

  it('returns undefined for an unknown / missing model (no fuzzy match)', () => {
    expect(priceFor('claude-haiku-9-9')).toBeUndefined();
    expect(priceFor(undefined)).toBeUndefined();
    expect(priceFor('claude-haiku')).toBeUndefined();
  });
});

describe('computeCostUsd — Haiku 4.5 ($1 in / $5 out / $0.10 cacheRead / $1.25 cacheWrite per MTok)', () => {
  it('prices a pure-uncached call', () => {
    // 1,000,000 in @ $1, 200,000 out @ $5 = $1.00 + $1.00 = $2.00
    const c = computeCostUsd(
      'claude-haiku-4-5',
      usage({ inputTokens: 1_000_000, outputTokens: 200_000 }),
    );
    expect(c.input).toBeCloseTo(1.0, 10);
    expect(c.output).toBeCloseTo(1.0, 10);
    expect(c.cacheRead).toBe(0);
    expect(c.cacheWrite).toBe(0);
    expect(c.total).toBeCloseTo(2.0, 10);
    expect(c.priced).toBe(true);
  });

  it('prices the four disjoint token buckets independently and sums them', () => {
    // in 10k@$1 = 0.01 ; out 2k@$5 = 0.01 ; cacheRead 100k@$0.10 = 0.01 ;
    // cacheWrite 8k@$1.25 = 0.01  → total 0.04
    const c = computeCostUsd(
      'claude-haiku-4-5',
      usage({
        inputTokens: 10_000,
        outputTokens: 2_000,
        cacheReadInputTokens: 100_000,
        cacheCreationInputTokens: 8_000,
      }),
    );
    expect(c.input).toBeCloseTo(0.01, 10);
    expect(c.output).toBeCloseTo(0.01, 10);
    expect(c.cacheRead).toBeCloseTo(0.01, 10);
    expect(c.cacheWrite).toBeCloseTo(0.01, 10);
    expect(c.total).toBeCloseTo(0.04, 10);
  });

  it('a cache hit is ~10x cheaper than the same tokens uncached', () => {
    const cached = computeCostUsd(
      'claude-haiku-4-5',
      usage({ cacheReadInputTokens: 1_000_000 }),
    );
    const uncached = computeCostUsd(
      'claude-haiku-4-5',
      usage({ inputTokens: 1_000_000 }),
    );
    expect(uncached.total / cached.total).toBeCloseTo(10, 6);
  });

  it('zero usage → zero cost but still priced', () => {
    const c = computeCostUsd('claude-haiku-4-5', usage({}));
    expect(c.total).toBe(0);
    expect(c.priced).toBe(true);
  });
});

describe('computeCostUsd — unpriced model', () => {
  it('returns total 0 but priced=false (not silently free)', () => {
    const c = computeCostUsd(
      'some-model-with-no-row',
      usage({ inputTokens: 5_000_000 }),
    );
    expect(c.total).toBe(0);
    expect(c.priced).toBe(false);
  });

  it('an undefined model is also flagged unpriced', () => {
    const c = computeCostUsd(undefined, usage({ inputTokens: 1_000 }));
    expect(c.priced).toBe(false);
  });
});

describe('price sheet sanity', () => {
  it('every row has cacheRead < input < output and cacheWrite > input', () => {
    for (const [, p] of Object.entries(MODEL_PRICES)) {
      expect(p.cacheReadPerMTok).toBeLessThan(p.inputPerMTok);
      expect(p.inputPerMTok).toBeLessThanOrEqual(p.outputPerMTok);
      expect(p.cacheWritePerMTok).toBeGreaterThan(p.inputPerMTok);
    }
  });
});
