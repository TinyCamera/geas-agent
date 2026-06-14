/**
 * Default-gate coverage for the standard verification scenarios (#674).
 *
 * Each scenario runs through the real {@link runVerifyScenario} driver against
 * the in-memory fake world with a {@link NoopProvider} replaying its
 * `noopScript` — deterministic, keyless, zero-cost. A scenario "passing" here
 * means: every per-turn `expectedEvents` matcher held AND its `asserts` did not
 * throw (`report.ok === true`, no `failures`). This is the gate that keeps the
 * standard scenario set honest on every `npm test`, independent of the live
 * LLM acceptance leg (`GEAS_LIVE_MCP_URL`).
 */

import { describe, expect, it } from 'vitest';

import { NoopProvider } from '../llm/noop.js';
import { createFakeWorld } from './fake-world.js';
import { runVerifyScenario } from './runner.js';
import { combat } from './scenarios/combat.js';
import { levelup } from './scenarios/levelup.js';
import { nav } from './scenarios/nav.js';
import { recovery } from './scenarios/recovery.js';
import { stuck } from './scenarios/stuck.js';
import { VERIFY_SCENARIOS, createVerifyRegistry } from './scenarios/index.js';
import type { VerifyScenario } from './types.js';

const STANDARD: readonly VerifyScenario[] = [combat, levelup, nav, recovery, stuck];

describe('standard verification scenarios (#674)', () => {
  for (const scenario of STANDARD) {
    it(`${scenario.name}: passes in default keyless mode`, async () => {
      const world = await createFakeWorld();
      const provider = new NoopProvider({ script: scenario.noopScript });
      const report = await runVerifyScenario(scenario, { world, provider });
      await world.close();

      // Surface the actual failures in the assertion message when red.
      expect(report.failures).toEqual([]);
      expect(report.ok).toBe(true);
      // Keyless run — no real model, so no spend.
      expect(report.totalCostUsd).toBe(0);
      // The script never blows the per-turn cap (no `maxTurns` failure).
      expect(report.toolCalls).toBeGreaterThan(0);
    });
  }

  it('combat lands exactly three kills', async () => {
    // `runVerifyScenario` calls `scenario.setup` itself, then drives the world
    // through real MCP dispatch — snapshot after to read the mutated state.
    const world = await createFakeWorld();
    const provider = new NoopProvider({ script: combat.noopScript });
    await runVerifyScenario(combat, { world, provider });
    const snap = await world.snapshot();
    await world.close();
    expect(snap.kills).toBe(3);
    expect(snap.enemiesAlive).toBe(0);
  });

  it('registers all six scenarios by name', () => {
    const registry = createVerifyRegistry();
    expect([...registry.keys()].sort()).toEqual(
      ['combat', 'levelup', 'nav', 'recovery', 'smoke', 'stuck'].sort(),
    );
    expect(VERIFY_SCENARIOS).toHaveLength(6);
  });
});
