/**
 * Unit tests for the cost-regression assertion (#675, parent epic #589).
 *
 * Pure logic, synthetic {@link VerifyReport}s — no LLM, no network, no key.
 * Validates (a) the baseline file round-trips and rebases, and (b) the
 * tolerance comparison flags regressions, tolerates improvements, and never
 * false-fails a keyless ($0) run against a real (>0) baseline.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VerifyReport } from './types.js';
import {
  DEFAULT_COST_TOLERANCE,
  emptyBaseline,
  parseBaseline,
  serializeBaseline,
  loadBaseline,
  saveBaseline,
  baselineFromReports,
  type CostBaselineFile,
} from './cost-baseline.js';
import {
  checkCostRegression,
  formatCostRegression,
} from './cost-regression.js';

function report(
  scenario: string,
  totalCostUsd: number,
  totalTokens = Math.round(totalCostUsd * 1_000_000),
): VerifyReport {
  return {
    scenario,
    ok: true,
    turns: 2,
    userTurns: 1,
    totalTokens,
    totalCostUsd,
    retries: 0,
    toolCalls: 1,
    durationMs: 1,
    failures: [],
  };
}

function baseline(
  entries: Record<string, { cost: number; tokens?: number; tol?: number }>,
  tolerance = DEFAULT_COST_TOLERANCE,
): CostBaselineFile {
  const scenarios: CostBaselineFile['scenarios'] = Object.fromEntries(
    Object.entries(entries).map(([name, e]) => [
      name,
      {
        scenario: name,
        baselineCostUsd: e.cost,
        baselineTokens: e.tokens ?? Math.round(e.cost * 1_000_000),
        ...(e.tol !== undefined ? { tolerance: e.tol } : {}),
      },
    ]),
  );
  return { tolerance, scenarios };
}

describe('cost-baseline file', () => {
  it('emptyBaseline carries the default tolerance and no scenarios', () => {
    const b = emptyBaseline();
    expect(b.tolerance).toBe(DEFAULT_COST_TOLERANCE);
    expect(b.scenarios).toEqual({});
  });

  it('serialize → parse round-trips, with stable sorted scenario keys', () => {
    const b = baseline({ stuck: { cost: 0.02 }, combat: { cost: 0.01, tol: 0.5 } });
    const text = serializeBaseline(b);
    // keys sorted: combat before stuck
    expect(text.indexOf('"combat"')).toBeLessThan(text.indexOf('"stuck"'));
    expect(text.endsWith('\n')).toBe(true);
    expect(parseBaseline(text)).toEqual(b);
  });

  it('parseBaseline rejects malformed input', () => {
    expect(() => parseBaseline('not json')).toThrow(/invalid JSON/i);
    expect(() => parseBaseline('[]')).toThrow(/object/i);
    expect(() => parseBaseline('{"tolerance":-1,"scenarios":{}}')).toThrow(/tolerance/i);
    expect(() =>
      parseBaseline('{"scenarios":{"x":{"baselineCostUsd":"hi","baselineTokens":1}}}'),
    ).toThrow(/baselineCostUsd/i);
  });

  it('loadBaseline returns an empty baseline when the file is absent', () => {
    const missing = join(tmpdir(), 'definitely-not-here-cost-baseline.json');
    expect(loadBaseline(missing)).toEqual(emptyBaseline());
  });

  it('saveBaseline + loadBaseline round-trip on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cost-baseline-'));
    const path = join(dir, 'cost-baseline.json');
    const b = baseline({ combat: { cost: 0.0123, tokens: 4200 } });
    saveBaseline(b, path);
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
    expect(loadBaseline(path)).toEqual(b);
  });

  it('baselineFromReports records each run, preserving prior per-scenario tolerance', () => {
    const previous = baseline({ combat: { cost: 0.01, tol: 0.5 }, nav: { cost: 0.03 } });
    const next = baselineFromReports([report('combat', 0.02), report('levelup', 0.05)], {
      previous,
    });
    // combat re-measured but keeps its custom tolerance
    expect(next.scenarios.combat).toEqual({
      scenario: 'combat',
      baselineCostUsd: 0.02,
      baselineTokens: 20000,
      tolerance: 0.5,
    });
    // brand-new scenario added
    expect(next.scenarios.levelup?.baselineCostUsd).toBe(0.05);
    // un-run prior scenario retained
    expect(next.scenarios.nav?.baselineCostUsd).toBe(0.03);
  });
});

describe('checkCostRegression', () => {
  it('passes when actual is within tolerance', () => {
    const res = checkCostRegression([report('combat', 0.011)], baseline({ combat: { cost: 0.01 } }));
    expect(res.ok).toBe(true);
    expect(res.rows[0]?.status).toBe('ok');
    expect(res.regressions).toEqual([]);
  });

  it('treats exactly-at-limit as a pass (not a regression)', () => {
    const b = baseline({ combat: { cost: 0.01 } }); // limit = 0.01 * 1.25
    const atLimit = 0.01 * (1 + DEFAULT_COST_TOLERANCE);
    const res = checkCostRegression([report('combat', atLimit)], b);
    expect(res.rows[0]?.status).toBe('ok');
    expect(res.ok).toBe(true);
  });

  it('flags a regression when actual exceeds baseline × (1 + tolerance)', () => {
    // A 2× cost blow-out against a default 25% budget — the ticket's
    // "deliberately expensive scenario fails the assertion" acceptance case.
    const res = checkCostRegression([report('combat', 0.02)], baseline({ combat: { cost: 0.01 } }));
    expect(res.ok).toBe(false);
    expect(res.rows[0]?.status).toBe('regressed');
    expect(res.regressions.map((r) => r.scenario)).toEqual(['combat']);
    expect(res.rows[0]?.deltaPct).toBeCloseTo(1.0, 6);
  });

  it('honors a per-scenario tolerance override over the default', () => {
    // 60% over baseline: would regress at default 25%, passes at a 100% override.
    const res = checkCostRegression(
      [report('recovery', 0.016)],
      baseline({ recovery: { cost: 0.01, tol: 1.0 } }),
    );
    expect(res.rows[0]?.status).toBe('ok');
    expect(res.rows[0]?.tolerance).toBe(1.0);
    expect(res.ok).toBe(true);
  });

  it('reports improvements without failing', () => {
    const res = checkCostRegression([report('nav', 0.005)], baseline({ nav: { cost: 0.01 } }));
    expect(res.rows[0]?.status).toBe('improved');
    expect(res.ok).toBe(true);
  });

  it('marks scenarios without a baseline as no-baseline, not a failure', () => {
    const res = checkCostRegression([report('combat', 0.5)], emptyBaseline());
    expect(res.rows[0]?.status).toBe('no-baseline');
    expect(res.missing).toEqual(['combat']);
    expect(res.ok).toBe(true);
  });

  it('never false-fails a keyless ($0) run against a real baseline', () => {
    const res = checkCostRegression(
      [report('combat', 0), report('nav', 0), report('stuck', 0)],
      baseline({ combat: { cost: 0.01 }, nav: { cost: 0.02 }, stuck: { cost: 0.03 } }),
    );
    expect(res.ok).toBe(true);
    expect(res.rows.every((r) => r.status === 'improved')).toBe(true);
  });

  it('fails the whole run if any single scenario regresses', () => {
    const res = checkCostRegression(
      [report('combat', 0.011), report('stuck', 0.10)],
      baseline({ combat: { cost: 0.01 }, stuck: { cost: 0.01 } }),
    );
    expect(res.ok).toBe(false);
    expect(res.regressions.map((r) => r.scenario)).toEqual(['stuck']);
  });
});

describe('formatCostRegression', () => {
  it('renders a per-scenario table and a clear regression verdict', () => {
    const res = checkCostRegression(
      [report('combat', 0.02), report('nav', 0.005)],
      baseline({ combat: { cost: 0.01 }, nav: { cost: 0.01 } }),
    );
    const text = formatCostRegression(res);
    expect(text).toContain('combat');
    expect(text).toContain('REGRESSED');
    expect(text).toContain('nav');
    expect(text).toMatch(/COST REGRESSION/i);
  });

  it('notes missing baselines and points at the rebase command', () => {
    const res = checkCostRegression([report('combat', 0)], emptyBaseline());
    const text = formatCostRegression(res);
    expect(text).toContain('NO-BASELINE');
    expect(text).toContain('verify:rebase-baseline');
    expect(text).toMatch(/no regressions/i);
  });
});
