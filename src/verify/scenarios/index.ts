/**
 * Verification scenario registry — single source of truth for which
 * verification scenarios exist (#673).
 *
 * Adding one: implement the {@link VerifyScenario} in a sibling file, then
 * append it here. The standard scenario set (combat, levelup, nav, recovery,
 * stuck) lands with #674; #673 ships only the `smoke` self-test.
 */

import type { VerifyScenario } from '../types.js';
import { smoke } from './smoke.js';

export const VERIFY_SCENARIOS: ReadonlyArray<VerifyScenario> = [smoke];

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
