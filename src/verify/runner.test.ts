/**
 * Self-test for the verification harness (#673).
 *
 * Runs the `smoke` scenario end-to-end through the real runner, against the
 * in-memory stateful fake world, driven by a `NoopProvider` replaying the
 * scenario's `noopScript` — exactly the path `npm run test:verify` takes by
 * default. Asserts the runner (a) actually mutated server state, (b) matched
 * the per-turn expectations, and (c) produced a correct {@link VerifyReport}.
 *
 * This is the "trivial scenario that asserts the runner runs and reports
 * correctly" the ticket's Tests section calls for, and it guards the harness
 * in the default `npm test` gate (no key, no network).
 */

import { describe, it, expect } from 'vitest';

import { NoopProvider } from '../llm/noop.js';
import { createFakeWorld } from './fake-world.js';
import { runVerifyScenario } from './runner.js';
import { createVerifyRegistry, VERIFY_SCENARIOS } from './scenarios/index.js';
import { smoke } from './scenarios/smoke.js';
import { formatReport } from './report.js';

describe('verify runner — smoke scenario', () => {
  it('drives the agent, mutates world state, and reports pass', async () => {
    const world = await createFakeWorld();
    try {
      const report = await runVerifyScenario(smoke, {
        world,
        provider: new NoopProvider({ script: smoke.noopScript ?? [] }),
      });

      expect(report.ok).toBe(true);
      expect(report.failures).toEqual([]);
      expect(report.scenario).toBe('smoke');
      expect(report.userTurns).toBe(1);
      // Two LLM round-trips: the move tool-use, then the closing narration.
      expect(report.turns).toBe(2);
      expect(report.toolCalls).toBe(1);
      expect(report.retries).toBe(0);
      // NoopProvider reports zero usage → zero cost.
      expect(report.totalTokens).toBe(0);
      expect(report.totalCostUsd).toBe(0);

      // The world actually moved (setup x=5 → +1 → x=6).
      const snap = await world.snapshot();
      expect(snap.position).toEqual({ x: 6, y: 5 });
      expect(snap.hp).toBe(30);
    } finally {
      await world.close();
    }
  });

  it('reports failure when an expectation is unmet', async () => {
    const world = await createFakeWorld();
    try {
      // Provider with an empty script: the loop never calls a tool and never
      // narrates the way the scenario expects, so expectations should miss.
      const report = await runVerifyScenario(smoke, {
        world,
        provider: new NoopProvider({ script: [] }),
      });
      expect(report.ok).toBe(false);
      expect(report.failures.length).toBeGreaterThan(0);
      // No move happened → assert step also fails.
      expect(
        report.failures.some((f) => f.includes('position')),
      ).toBe(true);
    } finally {
      await world.close();
    }
  });

  it('writes a JSONL forensic log when logDir is given', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'verify-log-'));
    const world = await createFakeWorld();
    try {
      const report = await runVerifyScenario(smoke, {
        world,
        provider: new NoopProvider({ script: smoke.noopScript ?? [] }),
        logDir: dir,
      });
      expect(report.logPath).toBe(join(dir, 'smoke.jsonl'));
      const contents = readFileSync(report.logPath!, 'utf8');
      const lines = contents.trim().split('\n').map((l) => JSON.parse(l));
      // Forensic stream includes scenario start/end + the tool-call event.
      expect(lines.some((l) => l.kind === 'scenario-start')).toBe(true);
      expect(lines.some((l) => l.kind === 'scenario-end' && l.ok === true)).toBe(true);
      expect(
        lines.some(
          (l) => l.kind === 'event' && l.event?.type === 'tool-call',
        ),
      ).toBe(true);
    } finally {
      await world.close();
    }
  });
});

describe('verify registry', () => {
  it('includes the smoke scenario and rejects duplicates', () => {
    const reg = createVerifyRegistry();
    expect(reg.get('smoke')).toBe(smoke);
    expect(VERIFY_SCENARIOS.length).toBeGreaterThanOrEqual(1);
    expect(() => createVerifyRegistry([smoke, smoke])).toThrow(/duplicate/);
  });
});

describe('formatReport', () => {
  it('renders a PASS line with stats', async () => {
    const world = await createFakeWorld();
    try {
      const report = await runVerifyScenario(smoke, {
        world,
        provider: new NoopProvider({ script: smoke.noopScript ?? [] }),
      });
      const text = formatReport(report);
      expect(text).toContain('PASS');
      expect(text).toContain('smoke');
      expect(text).toContain('toolCalls=1');
    } finally {
      await world.close();
    }
  });
});
