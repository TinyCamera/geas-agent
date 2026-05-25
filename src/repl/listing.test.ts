import { describe, it, expect } from 'vitest';
import type { SessionListingRow } from '../server/wire.js';
import {
  clip,
  formatCost,
  formatLastActive,
  renderListing,
} from './listing.js';

function row(over: Partial<SessionListingRow> = {}): SessionListingRow {
  return {
    sessionId: '4e1c-aaaa-bbbb-cccc',
    characterId: 'char-1',
    displayName: 'Niall-1',
    lastActive: '2026-05-21T09:14:33.000Z',
    turns: 37,
    totalCostUsd: 0.084,
    ...over,
  };
}

describe('clip', () => {
  it('returns the input when shorter than width', () => {
    expect(clip('abc', 10)).toBe('abc');
  });
  it('truncates with ellipsis', () => {
    expect(clip('1234567890abcdef', 6)).toBe('12345…');
  });
  it('handles width=1 sanely', () => {
    expect(clip('abc', 1)).toBe('…');
  });
});

describe('formatLastActive', () => {
  it('reduces ISO to YYYY-MM-DD HH:MM', () => {
    expect(formatLastActive('2026-05-21T09:14:33.000Z')).toBe('2026-05-21 09:14');
  });
  it('passes through non-ISO strings (truncated)', () => {
    expect(formatLastActive('???')).toBe('???');
  });
});

describe('formatCost', () => {
  it('two decimals for >=$1', () => {
    expect(formatCost(1.234)).toBe('$1.23');
  });
  it('three decimals for cents range', () => {
    expect(formatCost(0.084)).toBe('$0.084');
  });
  it('four decimals for sub-cent', () => {
    expect(formatCost(0.0012)).toBe('$0.0012');
  });
  it('$0.00 for exact zero', () => {
    expect(formatCost(0)).toBe('$0.00');
  });
});

describe('renderListing', () => {
  it('returns a "no sessions" line for empty input', () => {
    const lines = renderListing([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/no sessions/i);
  });

  it('renders header + rule + one row per session', () => {
    const lines = renderListing([row(), row({ sessionId: '9a44', displayName: 'goblin-bait', turns: 12, totalCostUsd: 0.021, lastActive: '2026-05-19T22:30:00.000Z' })]);
    expect(lines.length).toBe(4); // header + rule + 2 rows
    expect(lines[0]).toMatch(/sessionId/);
    expect(lines[0]).toMatch(/character/);
    expect(lines[0]).toMatch(/lastActive/);
    expect(lines[0]).toMatch(/turns/);
    expect(lines[1]).toMatch(/^─+$/u);
    expect(lines[2]).toMatch(/4e1c/);
    expect(lines[2]).toMatch(/Niall-1/);
    expect(lines[2]).toMatch(/2026-05-21 09:14/);
    expect(lines[2]).toMatch(/37/);
    expect(lines[2]).toMatch(/\$0\.084/);
    expect(lines[3]).toMatch(/goblin-bait/);
  });

  it('truncates a long display name', () => {
    const lines = renderListing([
      row({ displayName: 'this-is-a-very-very-very-long-display-name' }),
    ]);
    // The row line should not contain the entire long name — it must be clipped.
    expect(lines[2]).not.toMatch(/this-is-a-very-very-very-long-display-name/);
    expect(lines[2]).toMatch(/…/);
  });
});
