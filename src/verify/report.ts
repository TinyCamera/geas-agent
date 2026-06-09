/**
 * Human-readable rendering of {@link VerifyReport}s (#673).
 *
 * One block per scenario plus a roll-up footer. Kept dependency-free (plain
 * strings) so both the CLI and any future CI annotation can reuse it.
 */

import type { VerifyReport } from './types.js';

function fmtUsd(n: number): string {
  return `$${n.toFixed(6)}`;
}

/** Render one scenario report as a multi-line block. */
export function formatReport(r: VerifyReport): string {
  const head = `${r.ok ? 'PASS' : 'FAIL'}  ${r.scenario}`;
  const stats =
    `  turns=${r.turns} userTurns=${r.userTurns} ` +
    `toolCalls=${r.toolCalls} retries=${r.retries} ` +
    `tokens=${r.totalTokens} cost=${fmtUsd(r.totalCostUsd)} ` +
    `${r.durationMs}ms`;
  const lines = [head, stats];
  if (r.logPath) lines.push(`  log: ${r.logPath}`);
  for (const f of r.failures) lines.push(`  ✗ ${f}`);
  return lines.join('\n');
}

/**
 * Render a run summary footer (the per-scenario blocks are printed as each
 * scenario completes; this is just the roll-up).
 */
export function formatRun(reports: readonly VerifyReport[]): string {
  const passed = reports.filter((r) => r.ok).length;
  const totalCost = reports.reduce((s, r) => s + r.totalCostUsd, 0);
  return (
    `${passed}/${reports.length} scenarios passed — ` +
    `total cost ${fmtUsd(totalCost)}`
  );
}
