/**
 * Cost baseline file for the verification suite (#675, parent epic #589).
 *
 * The verification scenarios log a real-dollar cost per run (see
 * {@link '../verify/types.js'.VerifyReport.totalCostUsd}). To catch context
 * bloat / prompt drift / runaway retries *before* they ship, the suite asserts
 * each scenario's cost stays within a tolerance of a committed baseline. This
 * module owns the baseline's on-disk shape and the read/write/rebase helpers;
 * the comparison itself lives in {@link './cost-regression.js'}.
 *
 * The baseline is a git-tracked JSON file (`verify/cost-baseline.json`) so
 * intentional bumps land as reviewable diffs. Seed/refresh it from a *live*
 * run with `npm run verify:rebase-baseline` — a keyless ($0) run would write a
 * useless all-zero baseline (the CLI warns when it sees that).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { VerifyReport } from './types.js';

/** Default regression budget: 25% over baseline before a scenario fails. */
export const DEFAULT_COST_TOLERANCE = 0.25;

/** Conventional location of the committed baseline file. */
export const DEFAULT_BASELINE_PATH = join('verify', 'cost-baseline.json');

/** One scenario's recorded baseline. */
export interface CostBaselineEntry {
  readonly scenario: string;
  /** Recorded USD cost of the scenario at baseline. */
  readonly baselineCostUsd: number;
  /** Recorded token total at baseline (informational; the gate is on cost). */
  readonly baselineTokens: number;
  /** Per-scenario tolerance override (fraction; 0.25 = 25%). */
  readonly tolerance?: number;
}

/** The committed baseline file. */
export interface CostBaselineFile {
  /** Default tolerance for scenarios without their own override. */
  readonly tolerance: number;
  /** Per-scenario baselines, keyed by scenario name. */
  readonly scenarios: Readonly<Record<string, CostBaselineEntry>>;
}

/** A baseline with no scenarios recorded yet. */
export function emptyBaseline(tolerance = DEFAULT_COST_TOLERANCE): CostBaselineFile {
  return { tolerance, scenarios: {} };
}

function isFiniteNonNeg(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/** Parse + validate a baseline file's JSON text. Throws on malformed input. */
export function parseBaseline(json: string): CostBaselineFile {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`cost-baseline: invalid JSON: ${(e as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('cost-baseline: expected a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  const tolerance = obj.tolerance === undefined ? DEFAULT_COST_TOLERANCE : obj.tolerance;
  if (!isFiniteNonNeg(tolerance)) {
    throw new Error('cost-baseline: `tolerance` must be a non-negative number');
  }

  const scenariosRaw = obj.scenarios ?? {};
  if (typeof scenariosRaw !== 'object' || scenariosRaw === null || Array.isArray(scenariosRaw)) {
    throw new Error('cost-baseline: `scenarios` must be an object');
  }

  const scenarios: Record<string, CostBaselineEntry> = {};
  for (const [name, v] of Object.entries(scenariosRaw as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new Error(`cost-baseline: scenario '${name}' must be an object`);
    }
    const e = v as Record<string, unknown>;
    if (!isFiniteNonNeg(e.baselineCostUsd)) {
      throw new Error(
        `cost-baseline: scenario '${name}' baselineCostUsd must be a non-negative number`,
      );
    }
    if (!isFiniteNonNeg(e.baselineTokens)) {
      throw new Error(
        `cost-baseline: scenario '${name}' baselineTokens must be a non-negative number`,
      );
    }
    if (e.tolerance !== undefined && !isFiniteNonNeg(e.tolerance)) {
      throw new Error(`cost-baseline: scenario '${name}' tolerance must be a non-negative number`);
    }
    scenarios[name] = {
      scenario: name,
      baselineCostUsd: e.baselineCostUsd,
      baselineTokens: e.baselineTokens,
      ...(e.tolerance !== undefined ? { tolerance: e.tolerance as number } : {}),
    };
  }

  return { tolerance, scenarios };
}

/** Serialize a baseline to canonical JSON (sorted keys, trailing newline). */
export function serializeBaseline(b: CostBaselineFile): string {
  const scenarios: Record<string, CostBaselineEntry> = {};
  for (const name of Object.keys(b.scenarios).sort()) {
    scenarios[name] = b.scenarios[name]!;
  }
  return JSON.stringify({ tolerance: b.tolerance, scenarios }, null, 2) + '\n';
}

/** Read the baseline from disk. A missing file is an empty baseline. */
export function loadBaseline(path = DEFAULT_BASELINE_PATH): CostBaselineFile {
  if (!existsSync(path)) return emptyBaseline();
  return parseBaseline(readFileSync(path, 'utf8'));
}

/** Write a baseline to disk in canonical form. */
export function saveBaseline(b: CostBaselineFile, path = DEFAULT_BASELINE_PATH): void {
  writeFileSync(path, serializeBaseline(b));
}

/**
 * Build a new baseline from a set of just-run reports. Scenarios present in
 * `previous` but not re-run are retained as-is; re-run scenarios are
 * overwritten with their fresh cost/tokens while keeping any prior per-scenario
 * tolerance override.
 */
export function baselineFromReports(
  reports: readonly VerifyReport[],
  opts: { tolerance?: number; previous?: CostBaselineFile } = {},
): CostBaselineFile {
  const { previous } = opts;
  const tolerance = opts.tolerance ?? previous?.tolerance ?? DEFAULT_COST_TOLERANCE;

  const scenarios: Record<string, CostBaselineEntry> = {};
  if (previous) {
    for (const [name, e] of Object.entries(previous.scenarios)) scenarios[name] = e;
  }
  for (const r of reports) {
    const prevTol = previous?.scenarios[r.scenario]?.tolerance;
    scenarios[r.scenario] = {
      scenario: r.scenario,
      baselineCostUsd: r.totalCostUsd,
      baselineTokens: r.totalTokens,
      ...(prevTol !== undefined ? { tolerance: prevTol } : {}),
    };
  }

  return { tolerance, scenarios };
}
