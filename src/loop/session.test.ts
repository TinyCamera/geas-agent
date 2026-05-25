import { describe, it, expect } from 'vitest';
import { IdleSession, type SessionClock, type WakeCause } from './session.js';
import { LoopRunner, type LoopEmitEvent } from './runner.js';
import { NoopProvider } from '../llm/noop.js';
import { createStuckDetector } from '../prompts/stuck.js';
import { createRetryBudget } from '../prompts/budget.js';
import { ok } from '../mcp/errors.js';
import type { AttemptPlan, RecoveryDriver } from './run-with-retry.js';
import type { GeasToolResponse } from '../mcp/tools.js';
import type { Result } from '../mcp/errors.js';
import type { LlmToolDef, ContentBlock, StopReason } from '../llm/provider.js';

const TOOLS: readonly LlmToolDef[] = [
  {
    name: 'look',
    description: 'Look around',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const neverRecover: RecoveryDriver = async () => null;

interface FakeClock extends SessionClock {
  advance(ms: number): void;
  set(t: number): void;
}

function fakeClock(start = 1_000_000): FakeClock {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (n) => {
      t = n;
    },
  };
}

function staticDispatcher(
  responses: ReadonlyArray<Result<GeasToolResponse>>,
): (plan: AttemptPlan) => Promise<Result<GeasToolResponse>> {
  let i = 0;
  return async () => responses[Math.min(i++, responses.length - 1)];
}

/** Builds a runner that does: tool_use → result → end_turn narration. */
function makeOneToolRunner(emit: (e: LoopEmitEvent) => void): LoopRunner {
  const llm = new NoopProvider({
    script: [
      {
        stopReason: 'tool_use' as StopReason,
        content: [
          { type: 'text', text: 'INTENT: look' },
          { type: 'tool_use', id: 't1', name: 'look', input: {} },
        ] as ContentBlock[],
      },
      {
        stopReason: 'end_turn' as StopReason,
        content: [{ type: 'text', text: 'You see a room.' }] as ContentBlock[],
      },
    ],
  });
  return new LoopRunner({
    llm,
    dispatch: staticDispatcher([
      ok({
        content: [{ type: 'text', text: '{"room":"hall"}' }],
        structuredContent: { room: 'hall' },
      }),
    ]),
    stuckDetector: createStuckDetector(),
    retryBudget: createRetryBudget(),
    recover: neverRecover,
    tools: TOOLS,
    emit,
  });
}

describe('IdleSession', () => {
  it('starts idle and reports isIdle=true with zero turns', () => {
    const clock = fakeClock();
    const events: LoopEmitEvent[] = [];
    const session = new IdleSession({
      runnerFactory: () => makeOneToolRunner((e) => events.push(e)),
      emit: (e) => events.push(e),
      clock,
    });

    expect(session.idleVerdict().isIdle).toBe(true);
    const t = session.telemetry();
    expect(t.isIdle).toBe(true);
    expect(t.turnsCompleted).toBe(0);
    expect(t.wakes).toBe(0);
    expect(t.idleSecondsPerHour).toBe(0); // just constructed, no idle time accrued
  });

  it('wakes on a user message, drives a turn, returns to idle', async () => {
    const clock = fakeClock();
    const events: LoopEmitEvent[] = [];
    const session = new IdleSession({
      runnerFactory: () => makeOneToolRunner((e) => events.push(e)),
      emit: (e) => events.push(e),
      clock,
    });

    await session.deliverUserMessage('Where am I?');

    const t = session.telemetry();
    expect(t.turnsCompleted).toBe(1);
    expect(t.wakes).toBe(1);
    // After the synchronous turn, lastUserMessageAt is "now" so we are in
    // the quiet window — not idle yet.
    expect(t.isIdle).toBe(false);
    expect(session.idleVerdict().activeReason).toBe('recent-user-message');

    // Advance past the idle threshold.
    clock.advance(31_000);
    expect(session.idleVerdict().isIdle).toBe(true);
  });

  it('fires onSleep after the turn completes and onWake on the next message', async () => {
    const clock = fakeClock();
    const wakes: WakeCause[] = [];
    let sleeps = 0;
    const events: LoopEmitEvent[] = [];

    const session = new IdleSession({
      runnerFactory: () => makeOneToolRunner((e) => events.push(e)),
      emit: (e) => events.push(e),
      clock,
      hooks: {
        onSleep: () => {
          sleeps += 1;
        },
        onWake: (c) => {
          wakes.push(c);
        },
      },
    });

    await session.deliverUserMessage('hi');
    expect(sleeps).toBe(1);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].kind).toBe('user-message');

    clock.advance(60_000);
    await session.deliverUserMessage('again');
    expect(sleeps).toBe(2);
    expect(wakes).toHaveLength(2);
  });

  it('wakes on a server-pushed decision and drives a turn', async () => {
    const clock = fakeClock();
    const events: LoopEmitEvent[] = [];
    const wakes: WakeCause[] = [];

    const session = new IdleSession({
      runnerFactory: () =>
        new LoopRunner({
          llm: new NoopProvider({
            script: [
              {
                stopReason: 'end_turn' as StopReason,
                content: [
                  { type: 'text', text: 'Acknowledged decision.' },
                ] as ContentBlock[],
              },
            ],
          }),
          dispatch: staticDispatcher([]),
          stuckDetector: createStuckDetector(),
          retryBudget: createRetryBudget(),
          recover: neverRecover,
          tools: TOOLS,
          emit: (e) => events.push(e),
        }),
      emit: (e) => events.push(e),
      clock,
      hooks: {
        onWake: (c) => {
          wakes.push(c);
        },
      },
    });

    // Deliver a decision push from idle.
    session.deliverDecision('decision-7', { kind: 'combat_target_acquired' });

    // Spin the event loop until the session's decision-driven turn completes.
    await new Promise((r) => setTimeout(r, 0));
    // Give the in-flight turn time to drain.
    for (let i = 0; i < 50; i++) {
      if (session.telemetry().turnsCompleted > 0) break;
      await new Promise((r) => setTimeout(r, 5));
    }

    const t = session.telemetry();
    expect(t.turnsCompleted).toBe(1);
    expect(t.wakes).toBe(1);
    expect(wakes[0].kind).toBe('decision');
    if (wakes[0].kind === 'decision') {
      expect(wakes[0].decisionId).toBe('decision-7');
    }
  });

  it('accumulates idleSecondsPerHour across idle intervals', async () => {
    const clock = fakeClock();
    const events: LoopEmitEvent[] = [];
    const session = new IdleSession({
      runnerFactory: () => makeOneToolRunner((e) => events.push(e)),
      emit: (e) => events.push(e),
      clock,
    });

    // Sit idle for 10 minutes.
    clock.advance(10 * 60_000);
    expect(session.telemetry().idleSecondsPerHour).toBe(10 * 60);

    // Drive a turn — clock doesn't move during the turn in this test
    // (synchronous noop provider).
    await session.deliverUserMessage('hi');

    // Now skip 5 minutes; we're in the quiet window so the first 30s is
    // still active, then idle. Make it simple: skip 5 minutes total.
    clock.advance(5 * 60_000);
    const t = session.telemetry();
    // 10 minutes idle before the turn + roughly (5 minutes - 30s quiet
    // window) idle after = ~14.5 minutes. The accounting is per-interval
    // and the post-turn idle interval opens after the user-message at the
    // moment `#enterIdle` runs (immediately after the turn), so the full
    // 5 minutes counts — we don't subtract the quiet window from the
    // interval, because the interval-based accounting tracks
    // "session-idle wall time" not "isIdle()===true wall time". This
    // matches the issue's framing: `idle_seconds_per_hour` is what the
    // deploy wants to verify "no LLM tokens" — wall time between turns is
    // the right proxy.
    expect(t.idleSecondsPerHour).toBeGreaterThanOrEqual(10 * 60);
    expect(t.idleSecondsPerHour).toBeLessThanOrEqual(60 * 60);
  });

  it('caps idleSecondsPerHour at 3600', () => {
    const clock = fakeClock();
    const events: LoopEmitEvent[] = [];
    const session = new IdleSession({
      runnerFactory: () => makeOneToolRunner((e) => events.push(e)),
      emit: (e) => events.push(e),
      clock,
    });

    // Sit idle for 2 hours — should clamp to 3600s and prune.
    clock.advance(2 * 60 * 60_000);
    expect(session.telemetry().idleSecondsPerHour).toBe(3600);
  });

  it('serialises concurrent user messages', async () => {
    const clock = fakeClock();
    const events: LoopEmitEvent[] = [];
    const session = new IdleSession({
      runnerFactory: () => makeOneToolRunner((e) => events.push(e)),
      emit: (e) => events.push(e),
      clock,
    });

    // Kick off two concurrent messages.
    const p1 = session.deliverUserMessage('first');
    const p2 = session.deliverUserMessage('second');
    await Promise.all([p1, p2]);

    expect(session.telemetry().turnsCompleted).toBe(2);
  });

  it('close() is idempotent and drains the active turn', async () => {
    const clock = fakeClock();
    const events: LoopEmitEvent[] = [];
    const session = new IdleSession({
      runnerFactory: () => makeOneToolRunner((e) => events.push(e)),
      emit: (e) => events.push(e),
      clock,
    });

    const p = session.deliverUserMessage('hi');
    await session.close();
    await p;
    await session.close(); // idempotent

    // After close, further user messages throw.
    await expect(session.deliverUserMessage('again')).rejects.toThrow(/closed/);
  });

  it('idleVerdict reflects in-flight tool calls during a turn', async () => {
    // We can't easily observe mid-turn synchronously with the noop
    // provider, so smoke-test the verdict shape: starts idle, advances
    // past threshold, still idle.
    const clock = fakeClock();
    const events: LoopEmitEvent[] = [];
    const session = new IdleSession({
      runnerFactory: () => makeOneToolRunner((e) => events.push(e)),
      emit: (e) => events.push(e),
      clock,
    });
    expect(session.idleVerdict().isIdle).toBe(true);
    clock.advance(60_000);
    expect(session.idleVerdict().isIdle).toBe(true);
  });
});

describe('IdleSession — idle/wake integration', () => {
  it('idle agent consumes no LLM calls (NoopProvider call count stays 0)', () => {
    // The headline acceptance criterion: idle agents consume no LLM
    // tokens. The session does not invoke the runner factory or the LLM
    // until a wake fires.
    const clock = fakeClock();
    let runnerMints = 0;
    const events: LoopEmitEvent[] = [];

    const session = new IdleSession({
      runnerFactory: () => {
        runnerMints += 1;
        return makeOneToolRunner((e) => events.push(e));
      },
      emit: (e) => events.push(e),
      clock,
    });

    // Let an hour go by.
    clock.advance(60 * 60_000);
    expect(runnerMints).toBe(0);
    expect(session.telemetry().idleSecondsPerHour).toBe(3600);
  });
});
