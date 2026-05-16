/**
 * The scenario registry — single source of truth for which scenarios exist.
 *
 * Adding one means: implement the `Scenario` function in a sibling file, then
 * append a `ScenarioRegistration` here. The CLI looks up by name; the runner
 * `tests` exercise the registry shape rather than each scenario individually.
 */

import type { ScenarioRegistration } from './types.js';
import { goblinHunt } from './goblin-hunt.js';

export const SCENARIOS: ReadonlyArray<ScenarioRegistration> = [
  {
    name: 'goblin-hunt',
    description:
      'Find nearest goblin, attack until it dies (or HP <30%), return to spawn',
    run: goblinHunt,
  },
];

export function createScenarioRegistry(
  entries: ReadonlyArray<ScenarioRegistration> = SCENARIOS,
): ReadonlyMap<string, ScenarioRegistration> {
  const map = new Map<string, ScenarioRegistration>();
  for (const e of entries) {
    if (map.has(e.name)) {
      throw new Error(`duplicate scenario registration: ${e.name}`);
    }
    map.set(e.name, e);
  }
  return map;
}
