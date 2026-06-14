/**
 * Cost-regression assertion for the verification suite (#675, parent epic #589).
 *
 * Given the per-scenario {@link VerifyReport}s a run produced and a committed
 * {@link CostBaselineFile}, decide whether any scenario's cost regressed past
 * its tolerance. Pure and side-effect-free: the CLI (`test:verify`) loads the
 * baseline, runs this, prints the table, and exits non-zero on a regression.
 *
 * Semantics:
 *   - A scenario *regresses* iff `actualCostUsd > baselineCostUsd × (1 + tol)`.
 *   - Exactly at the limit passes (budget is inclusive).
 *   - Cost strictly below baseline is an *improvement* (still a pass).
 *   - A scenario with no baseline entry is *no-baseline* — reported, never a
 *     failure (so adding a scenario before seeding its baseline can't break CI;
 *     seed it with `npm run verify:rebase-baseline`).
 *
 * Because keyless (NoopProvider) runs report `$0`, they never regress against a
 * real (>0) baseline — they show as improvements — so the same assertion is
 * safe in the default keyless gate and in the live acceptance leg.
 */

import type { VerifyReport } from './types.js';
import type { CostBaselineFile } from './cost-baseline.js';
import { DEFAULT_COST_TOLERANCE } from './cost-baseline.js';

export type CostRowStatus = 'ok' | 'regressed' | 'improved' | 'no-baseline';

/** One scenario's cost verdict. */
export interface CostRow {
  readonly scenario: string;
  /** Baseline cost, or `null` when no baseline exists for this scenario. */
  readonly baselineCostUsd: number | null;
  readonly actualCostUsd: number;
  /** `baseline × (1 + tolerance)`, or `null` when no baseline exists. */
  readonly limitUsd: number | null;
  readonly tolerance: number;
  /** Fractional change vs baseline (`null` when no baseline). */
  readonly deltaPct: number | null;
  readonly status: CostRowStatus;
}

/** The whole run's cost verdict. */
export interface CostRegressionResult {
  /** True iff no scenario regressed. */
  readonly ok: boolean;
  readonly rows: readonly CostRow[];
  readonly regressions: readonly CostRow[];
  /** Names of scenarios that ran without a baseline entry. */
  readonly missing: readonly string[];
}

/** Compare a run's reports against the committed baseline. */
export function checkCostRegression(
  reports: readonly VerifyReport[],
  baseline: CostBaselineFile,
): CostRegressionResult {
  const defaultTol = Number.isFinite(baseline.tolerance)
    ? baseline.tolerance
    : DEFAULT_COST_TOLERANCE;

  const rows: CostRow[] = reports.map((r) => {
    const entry = baseline.scenarios[r.scenario];
    const tolerance = entry?.tolerance ?? defaultTol;

    if (!entry) {
      return {
        scenario: r.scenario,
        baselineCostUsd: null,
        actualCostUsd: r.totalCostUsd,
        limitUsd: null,
        tolerance,
        deltaPct: null,
        status: 'no-baseline',
      };
    }

    const limitUsd = entry.baselineCostUsd * (1 + tolerance);
    const deltaPct =
      entry.baselineCostUsd > 0
        ? (r.totalCostUsd - entry.baselineCostUsd) / entry.baselineCostUsd
        : r.totalCostUsd > 0
          ? Number.POSITIVE_INFINITY
          : 0;

    let status: CostRowStatus;
    if (r.totalCostUsd > limitUsd) status = 'regressed';
    else if (r.totalCostUsd < entry.baselineCostUsd) status = 'improved';
    else status = 'ok';

    return {
      scenario: r.scenario,
      baselineCostUsd: entry.baselineCostUsd,
      actualCostUsd: r.totalCostUsd,
      limitUsd,
      tolerance,
      deltaPct,
      status,
    };
  });

  const regressions = rows.filter((r) => r.status === 'regressed');
  const missing = rows.filter((r) => r.status === 'no-baseline').map((r) => r.scenario);

  return { ok: regressions.length === 0, rows, regressions, missing };
}

const STATUS_LABEL: Record<CostRowStatus, string> = {
  ok: 'OK',
  regressed: 'REGRESSED',
  improved: 'IMPROVED',
  'no-baseline': 'NO-BASELINE',
};

function fmtUsd(n: number | null): string {
  return n === null ? '—' : `$${n.toFixed(6)}`;
}

function fmtPct(n: number | null): string {
  if (n === null) return '—';
  if (!Number.isFinite(n)) return '+∞%';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${(n * 100).toFixed(1)}%`;
}

/** Render the cost verdict as a plain-text diff table + summary verdict. */
export function formatCostRegression(result: CostRegressionResult): string {
  const lines: string[] = ['[cost-regression]'];
  for (const r of result.rows) {
    lines.push(
      `  ${STATUS_LABEL[r.status].padEnd(11)} ${r.scenario.padEnd(10)} ` +
        `actual=${fmtUsd(r.actualCostUsd)} baseline=${fmtUsd(r.baselineCostUsd)} ` +
        `limit=${fmtUsd(r.limitUsd)} Δ=${fmtPct(r.deltaPct)} ` +
        `(tol ${(r.tolerance * 100).toFixed(0)}%)`,
    );
  }
  if (result.missing.length > 0) {
    lines.push(
      `  ${result.missing.length} scenario(s) without a baseline: ` +
        `${result.missing.join(', ')}. ` +
        'Run `npm run verify:rebase-baseline` (live) to seed them.',
    );
  }
  lines.push(
    result.ok
      ? '  cost OK — no regressions'
      : `  COST REGRESSION — ${result.regressions.length} scenario(s) over budget: ` +
          result.regressions.map((r) => r.scenario).join(', '),
  );
  return lines.join('\n');
}
