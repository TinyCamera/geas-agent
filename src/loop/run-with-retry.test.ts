/**
 * Unit tests for `runWithRetry` — the composed retry contract.
 *
 * These run under `npm test` with no live server / no LLM. They prove the
 * composition's branching is correct for every failure mode the #586 epic
 * enumerates. The companion live tests at
 * `tests/integration/retry-layer.live.test.ts` re-prove the same contract
 * against a real geas-server + real model.
 */

import { describe, it, expect } from 'vitest';

import { runWithRetry, type AttemptPlan, type RecoveryDriver } from './run-with-retry.js';
import { createStuckDetector } from '../prompts/stuck.js';
import { createRetryBudget } from '../prompts/budget.js';
import { err, ok, type Result } from '../mcp/errors.js';
import { makeError } from '../mcp/errors.js';
import type { GeasToolResponse } from '../mcp/tools.js';

function okResponse(): Result<GeasToolResponse> {
  // Shape doesn't matter for these tests — the runner returns whatever
  // dispatch returned on success, opaque.
  return ok({
    content: [{ type: 'text', text: 'ok' }],
    structuredContent: { ok: true },
  } as unknown as GeasToolResponse);
}

function unknownToolErr(name: string): Result<GeasToolResponse> {
  return err(
    makeError('unknown_tool', `unknown tool: ${name}`, { tool: name }),
  );
}

function missingRequiredErr(name: string, arg: string): Result<GeasToolResponse> {
  return err(
    makeError('missing_required', `tool '${name}' missing required arg: ${arg}`, {
      tool: name,
      args: [arg],
    }),
  );
}

function toolErr(name: string, message: string): Result<GeasToolResponse> {
  return err(makeError('tool_error', message, { tool: name }));
}

describe('runWithRetry — happy path', () => {
  it('returns ok on first-attempt success with recovered=false', async () => {
    const dispatch = async (_plan: AttemptPlan) => okResponse();
    const recover: RecoveryDriver = async () => null;
    const outcome = await runWithRetry({
      initial: { tool: 'look', args: {}, intent: 'observe' },
      dispatch,
      recover,
      stuckDetector: createStuckDetector(),
      retryBudget: createRetryBudget({ budget: 3 }),
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.attempts).toBe(1);
    expect(outcome.recovered).toBe(false);
  });

  it('recovers from an unknown_tool failure on retry (recovered=true)', async () => {
    let calls = 0;
    const dispatch = async (plan: AttemptPlan) => {
      calls++;
      if (plan.tool === 'loook') return unknownToolErr('loook');
      return okResponse();
    };
    const recover: RecoveryDriver = async (ctx) => {
      // Driver receives the recovery prompt and "fixes" the typo.
      expect(ctx.recoveryPrompt).toContain('`loook`');
      expect(ctx.recoveryPrompt).toContain('unknown tool');
      expect(ctx.priorIntent).toBe('observe');
      return { tool: 'look', args: {}, intent: 'observe' };
    };
    const outcome = await runWithRetry({
      initial: { tool: 'loook', args: {}, intent: 'observe' },
      dispatch,
      recover,
      stuckDetector: createStuckDetector(),
      retryBudget: createRetryBudget({ budget: 3 }),
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.attempts).toBe(2);
    expect(outcome.recovered).toBe(true);
    expect(calls).toBe(2);
  });

  it('recovers from a missing_required failure on retry', async () => {
    const dispatch = async (plan: AttemptPlan) => {
      if (plan.tool === 'act' && !('intent' in plan.args)) {
        return missingRequiredErr('act', 'intent');
      }
      return okResponse();
    };
    const recover: RecoveryDriver = async (ctx) => {
      expect(ctx.failure.category).toBe('missing_required');
      return {
        tool: 'act',
        args: { intent: 'attack', intents: [{ kind: 'attack', targetEntityId: 'x' }] },
        intent: 'engage',
      };
    };
    const outcome = await runWithRetry({
      initial: { tool: 'act', args: {}, intent: 'engage' },
      dispatch,
      recover,
      stuckDetector: createStuckDetector(),
      retryBudget: createRetryBudget({ budget: 3 }),
    });
    expect(outcome.status).toBe('ok');
  });

  it('recovers from a server tool_error by picking a different action', async () => {
    let stage = 0;
    const dispatch = async (plan: AttemptPlan) => {
      stage++;
      if (stage === 1) {
        expect(plan.tool).toBe('act');
        return toolErr('act', 'target out of range');
      }
      // 2nd dispatch: model picks `move` toward the target.
      expect(plan.tool).toBe('act');
      expect(plan.args.intents).toBeDefined();
      return okResponse();
    };
    const recover: RecoveryDriver = async (ctx) => {
      expect(ctx.failure.category).toBe('tool_error');
      expect(ctx.recoveryPrompt).toContain('target out of range');
      return {
        tool: 'act',
        args: { intent: 'move', intents: [{ kind: 'move', target: { x: 10, y: 10 } }] },
        intent: 'close the gap then attack',
      };
    };
    const outcome = await runWithRetry({
      initial: {
        tool: 'act',
        args: { intent: 'attack', intents: [{ kind: 'attack', targetEntityId: 'far' }] },
        intent: 'attack the goblin',
      },
      dispatch,
      recover,
      stuckDetector: createStuckDetector(),
      retryBudget: createRetryBudget({ budget: 3 }),
    });
    expect(outcome.status).toBe('ok');
  });
});

describe('runWithRetry — stuck path', () => {
  it('fires stuck when the driver returns the same failing call twice', async () => {
    const dispatch = async (_plan: AttemptPlan) => unknownToolErr('loook');
    const recover: RecoveryDriver = async () =>
      // Driver ignores the recovery prompt — keeps producing the same typo.
      ({ tool: 'loook', args: {}, intent: 'observe' });
    const outcome = await runWithRetry({
      initial: { tool: 'loook', args: {}, intent: 'observe' },
      dispatch,
      recover,
      stuckDetector: createStuckDetector(),
      retryBudget: createRetryBudget({ budget: 10 }),
    });
    expect(outcome.status).toBe('stuck');
    if (outcome.status !== 'stuck') return;
    expect(outcome.signal.tool).toBe('loook');
    expect(outcome.signal.consecutiveFailures).toBeGreaterThanOrEqual(2);
    // Stuck fires on the 2nd identical failure → 2 attempts.
    expect(outcome.attempts).toBe(2);
  });

  it('does not fire stuck when the driver varies args between failures', async () => {
    let stage = 0;
    const dispatch = async (_plan: AttemptPlan) => {
      stage++;
      return toolErr('act', `failure ${stage}`);
    };
    const recover: RecoveryDriver = async (ctx) =>
      // Each retry tries a different action.
      ({ tool: 'act', args: { try: ctx.attempt + 1 }, intent: 'experiment' });
    const outcome = await runWithRetry({
      initial: { tool: 'act', args: { try: 1 }, intent: 'experiment' },
      dispatch,
      recover,
      stuckDetector: createStuckDetector(),
      retryBudget: createRetryBudget({ budget: 3 }),
    });
    // Budget exhausts before stuck can fire (all calls differ).
    expect(outcome.status).toBe('exhausted');
  });
});

describe('runWithRetry — budget exhaustion', () => {
  it('exhausts at budget=3 with the right event', async () => {
    let stage = 0;
    const dispatch = async (_plan: AttemptPlan) => {
      stage++;
      return toolErr('act', `failure ${stage}`);
    };
    const recover: RecoveryDriver = async (ctx) =>
      // Each retry varies args → stuck doesn't fire.
      ({ tool: 'act', args: { stage: ctx.attempt + 1 }, intent: 'progress' });
    const budget = createRetryBudget({ budget: 3 });
    const outcome = await runWithRetry({
      initial: { tool: 'act', args: { stage: 1 }, intent: 'progress' },
      dispatch,
      recover,
      stuckDetector: createStuckDetector(),
      retryBudget: budget,
    });
    expect(outcome.status).toBe('exhausted');
    if (outcome.status !== 'exhausted') return;
    expect(outcome.event.kind).toBe('retry_budget_exhausted');
    expect(outcome.event.budget).toBe(3);
    expect(outcome.event.retries).toBe(3);
    expect(outcome.event.detail.tool).toBe('act');
    expect(outcome.event.detail.category).toBe('tool_error');
    expect(budget.telemetry.exhausted).toBe(true);
  });

  it('exhausts immediately at budget=0', async () => {
    const dispatch = async (_plan: AttemptPlan) => toolErr('act', 'boom');
    const recover: RecoveryDriver = async () =>
      ({ tool: 'act', args: { v: 2 }, intent: 'try again' });
    const outcome = await runWithRetry({
      initial: { tool: 'act', args: { v: 1 }, intent: 'try' },
      dispatch,
      recover,
      stuckDetector: createStuckDetector(),
      retryBudget: createRetryBudget({ budget: 0 }),
    });
    expect(outcome.status).toBe('exhausted');
  });
});

describe('runWithRetry — give-up', () => {
  it('returns gave_up cleanly when the driver returns null', async () => {
    const dispatch = async (_plan: AttemptPlan) => toolErr('act', 'nope');
    const recover: RecoveryDriver = async () => null;
    const outcome = await runWithRetry({
      initial: { tool: 'act', args: {}, intent: 'try' },
      dispatch,
      recover,
      stuckDetector: createStuckDetector(),
      retryBudget: createRetryBudget({ budget: 5 }),
    });
    expect(outcome.status).toBe('gave_up');
    if (outcome.status !== 'gave_up') return;
    expect(outcome.attempts).toBe(1);
    expect(outcome.lastFailure.toolName).toBe('act');
  });
});

describe('runWithRetry — programmer errors', () => {
  it('throws when initial is missing', async () => {
    await expect(
      runWithRetry({
        // @ts-expect-error deliberately bad
        initial: undefined,
        dispatch: async () => okResponse(),
        recover: async () => null,
        stuckDetector: createStuckDetector(),
        retryBudget: createRetryBudget({ budget: 3 }),
      }),
    ).rejects.toThrow(/initial/);
  });
});
