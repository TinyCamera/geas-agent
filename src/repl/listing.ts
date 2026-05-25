/**
 * REPL `--list` renderer (#650).
 *
 * Pure: takes the wire `SessionListingRow[]` shape and returns the lines to
 * print, ready for stdout. The CLI in `cli.ts` is responsible for fetching
 * + exiting; this module is just the table layout.
 *
 * Layout (matches the issue body, but widths are derived from the data so
 * mixed name lengths don't bleed):
 *
 *   sessionId                  character     lastActive           turns   $ to date
 *   ─────────────────────────────────────────────────────────────────────────────
 *   4e1c…                      Niall-1       2026-05-21 09:14     37      $0.084
 *
 * **Truncation.** `displayName` is clipped to 20 chars (then `…`) — long names
 * (in-world titles, vendor-NPC handles) otherwise blow the table to one row
 * per line. `sessionId` clips to 12 chars + `…` for the same reason.
 */

import type { SessionListingRow } from '../server/wire.js';

const SID_WIDTH = 14; // 12 chars + ellipsis room
const NAME_WIDTH = 20;
const ACTIVE_WIDTH = 20; // "YYYY-MM-DD HH:MM:SS"
const TURNS_WIDTH = 6;

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

/** Truncate to `w` chars, appending "…" if shortened. */
export function clip(s: string, w: number): string {
  if (s.length <= w) return s;
  if (w <= 1) return '…';
  return s.slice(0, w - 1) + '…';
}

/** Format an ISO-8601 timestamp into the table's "YYYY-MM-DD HH:MM" form. */
export function formatLastActive(iso: string): string {
  // Tolerate non-ISO inputs by returning the raw string truncated.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)) {
    return clip(iso, ACTIVE_WIDTH);
  }
  // Replace the 'T' with a space, drop seconds + fractional + zone.
  return iso.replace('T', ' ').slice(0, 16);
}

export function formatCost(usd: number): string {
  // Two significant figures past the leading zero. $0.084, $0.0012, $1.20.
  if (usd === 0) return '$0.00';
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

/**
 * Render the `--list` table. Returns the lines (no trailing newlines on the
 * strings themselves — the caller joins with `\n`). Empty input emits a
 * one-line "no sessions" notice.
 */
export function renderListing(rows: readonly SessionListingRow[]): readonly string[] {
  if (rows.length === 0) {
    return ['(no sessions — start a fresh one with `--new` or no flag)'];
  }
  const header =
    pad('sessionId', SID_WIDTH) +
    '  ' +
    pad('character', NAME_WIDTH) +
    '  ' +
    pad('lastActive', ACTIVE_WIDTH) +
    '  ' +
    pad('turns', TURNS_WIDTH) +
    '  ' +
    '$ to date';
  // Underline matches the visible width of the header content (rough).
  const rule = '─'.repeat(header.length);
  const body = rows.map((r) => {
    return (
      pad(clip(r.sessionId, SID_WIDTH), SID_WIDTH) +
      '  ' +
      pad(clip(r.displayName, NAME_WIDTH), NAME_WIDTH) +
      '  ' +
      pad(formatLastActive(r.lastActive), ACTIVE_WIDTH) +
      '  ' +
      pad(String(r.turns), TURNS_WIDTH) +
      '  ' +
      formatCost(r.totalCostUsd)
    );
  });
  return [header, rule, ...body];
}
