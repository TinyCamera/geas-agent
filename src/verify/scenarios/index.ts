/**
 * Verification scenario registry — single source of truth for which
 * verification scenarios exist (#673).
 *
 * Adding one: implement the {@link VerifyScenario} in a sibling file, then
 * append it here. The `smoke` self-test shipped with the harness (#673); the
 * standard scenario set (combat, levelup, nav, recovery, stuck) lands with
 * #674.
 */

import type { VerifyScenario } from '../types.js';
import { smoke } from './smoke.js';
import { combat } from './combat.js';
import { levelup } from './levelup.js';
import { nav } from './nav.js';
import { recovery } from './recovery.js';
import { stuck } from './stuck.js';

export const VERIFY_SCENARIOS: ReadonlyArray<VerifyScenario> = [
  smoke,
  combat,
  levelup,
  nav,
  recovery,
  stuck,
];

/** Build a name→scenario lookup, rejecting duplicate names. */
export function createVerifyRegistry(
  entries: ReadonlyArray<VerifyScenario> = VERIFY_SCENARIOS,
): ReadonlyMap<string, VerifyScenario> {
  const map = new Map<string, VerifyScenario>();
  for (const s of entries) {
    if (map.has(s.name)) {
      throw new Error(`duplicate verify scenario: ${s.name}`);
    }
    map.set(s.name, s);
  }
  return map;
}
