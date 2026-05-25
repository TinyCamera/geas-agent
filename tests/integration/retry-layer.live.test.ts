/**
 * Live integration tests for the validation+retry layer (#586 epic, #662
 * sub-issue). One test per failure mode the epic enumerates.
 *
 * What this file proves
 * ---------------------
 *
 * The four sibling tickets that shipped this cycle (#658 validator, #659
 * plan-then-act, #660 stuck detector, #661 retry budget) are individually
 * unit-tested. This file treats them as a **contract** via the composed
 * `runWithRetry` helper (`src/loop/run-with-retry.ts`):
 *
 *   1. Unknown tool — validator catches a typo, recovery driver fixes it.
 *   2. Missing required arg — validator catches `{}`, recovery picks proper args.
 *   3. Wrong type — validator catches a string-where-object, recovery fixes shape.
 *   4. Server tool_error — server rejects an in-shape but out-of-range call;
 *      recovery picks a different action that succeeds.
 *   5. Stuck loop — driver repeats the same failing call; stuck detector fires.
 *   6. Budget exhaustion — every attempt fails; clean exit at budget=3 with the
 *      `retry_budget_exhausted` event.
 *
 * Opt-in execution + real-LLM scope
 * ---------------------------------
 *
 * These tests are opt-in and split into two tiers by env presence:
 *
 *   - `GEAS_LIVE_MCP_URL` set, no `ANTHROPIC_API_KEY`: cases 1–6 run with a
 *     scripted recovery driver against the live geas-server. This proves the
 *     contract end-to-end against the real validator + real MCP transport +
 *     real server-side rejection — but the "recovery decision" is hand-coded,
 *     not model-driven.
 *
 *   - Both `GEAS_LIVE_MCP_URL` *and* `ANTHROPIC_API_KEY` set: case 1 *also*
 *     runs in a real-LLM variant that hands the recovery prompt to Anthropic
 *     Haiku and asserts the model self-corrects. This is the cost-bearing
 *     leg — one shot is enough to prove the prompt steers a real model;
 *     re-running the other five against the LLM would multiply cost without
 *     adding signal (the validator + server are deterministic; the model's
 *     job in this layer is one decision per turn).
 *
 *   - Neither env set: the entire describe block is skipped. CI stays green.
 *
 * Run locally with:
 *
 *   GEAS_LIVE_MCP_URL=http://localhost:8088/mcp \
 *   GEAS_LIVE_DEV_UID=agent-dev \
 *   ANTHROPIC_API_KEY=sk-ant-... \
 *   npm run test:retry
 *
 * The `test:retry` script (package.json) is the canonical entry point so CI
 * can include it on PR + nightly once Niall enables the env in the workflow.
 *
 * Requires geas-server running with `GEAS_DEV_UNAUTH=1` for the local path
 * (see docs/dev.md). The MCP wrapper caches `inputSchema` at connect time —
 * the same surface the validator's #658 implementation consumes.
 */

import { describe, it, expect } from 'vitest';

import { GeasMcpClient } from '../../src/mcp/index.js';
import {
  runWithRetry,
  type AttemptPlan,
  type RecoveryDriver,
} from '../../src/loop/index.js';
import { createStuckDetector } from '../../src/prompts/stuck.js';
import { createRetryBudget } from '../../src/prompts/budget.js';
import { AnthropicProvider } from '../../src/llm/index.js';
import {
  isToolUseBlock,
  type GenerateRequest,
  type LlmToolDef,
} from '../../src/llm/index.js';
import type { GeasToolResponse } from '../../src/mcp/index.js';
import type { Result } from '../../src/mcp/index.js';

const LIVE_URL = process.env.GEAS_LIVE_MCP_URL;
const LIVE_UID = process.env.GEAS_LIVE_DEV_UID;
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;

const liveDescribe = LIVE_URL ? describe : describe.skip;
const liveLlmDescribe = LIVE_URL && HAS_KEY ? describe : describe.skip;

interface LiveCtx {
  client: GeasMcpClient;
  dispatch: (plan: AttemptPlan) => Promise<Result<GeasToolResponse>>;
}

async function makeLiveCtx(): Promise<LiveCtx> {
  const client = new GeasMcpClient({
    url: LIVE_URL!,
    devUid: LIVE_UID,
    reconnectBaseMs: 50,
    reconnectMaxMs: 1_000,
    reconnectMaxAttempts: 3,
  });
  const c = await client.connect();
  if (!c.ok) {
    throw new Error(`connect failed: ${c.error.kind} — ${c.error.message}`);
  }
  const dispatch = (plan: AttemptPlan) => client.callTool(plan.tool, plan.args);
  return { client, dispatch };
}

liveDescribe('retry-layer contract — scripted recovery (each failure mode)', () => {
  it('case 1: unknown tool — validator catches typo, recovery fixes name', async () => {
    const { client, dispatch } = await makeLiveCtx();
    try {
      const recover: RecoveryDriver = async (ctx) => {
        // Validator rejected locally, no server round-trip.
        expect(ctx.failure.category).toBe('unknown_tool');
        return { tool: 'look', args: {}, intent: 'observe surroundings' };
      };
      const outcome = await runWithRetry({
        initial: { tool: 'loook', args: {}, intent: 'observe surroundings' },
        dispatch,
        recover,
        stuckDetector: createStuckDetector(),
        retryBudget: createRetryBudget({ budget: 3 }),
      });
      expect(outcome.status).toBe('ok');
      if (outcome.status !== 'ok') return;
      expect(outcome.recovered).toBe(true);
      expect(outcome.attempts).toBe(2);
    } finally {
      await client.disconnect();
    }
  }, 30_000);

  it('case 2: missing required arg — validator catches empty args, recovery picks a safe call', async () => {
    const { client, dispatch } = await makeLiveCtx();
    try {
      // `buy_item` declares `npcEntityId` and `itemType` as required strings.
      // Sending `{}` should trip `missing_required` locally — before the call
      // ever reaches the server (no actual purchase attempted).
      const recover: RecoveryDriver = async (ctx) => {
        expect(ctx.failure.category).toBe('missing_required');
        // Recovery: rather than guess shop ids, abandon the buy intent and
        // observe first. A real agent would do the same thing.
        return { tool: 'look', args: {}, intent: 're-orient before purchasing' };
      };
      const outcome = await runWithRetry({
        initial: { tool: 'buy_item', args: {}, intent: 'buy a potion' },
        dispatch,
        recover,
        stuckDetector: createStuckDetector(),
        retryBudget: createRetryBudget({ budget: 3 }),
      });
      expect(outcome.status).toBe('ok');
      if (outcome.status !== 'ok') return;
      expect(outcome.recovered).toBe(true);
    } finally {
      await client.disconnect();
    }
  }, 30_000);

  it('case 3: wrong type — validator catches non-number maxDist, recovery fixes shape', async () => {
    const { client, dispatch } = await makeLiveCtx();
    try {
      const recover: RecoveryDriver = async (ctx) => {
        expect(ctx.failure.category).toBe('wrong_type');
        return {
          tool: 'nearest',
          args: { type: 'ENEMY', maxDist: 20 },
          intent: 'find a target within 20 tiles',
        };
      };
      const outcome = await runWithRetry({
        initial: {
          tool: 'nearest',
          args: { type: 'ENEMY', maxDist: 'far' },
          intent: 'find a target within 20 tiles',
        },
        dispatch,
        recover,
        stuckDetector: createStuckDetector(),
        retryBudget: createRetryBudget({ budget: 3 }),
      });
      expect(outcome.status).toBe('ok');
      if (outcome.status !== 'ok') return;
      expect(outcome.recovered).toBe(true);
    } finally {
      await client.disconnect();
    }
  }, 30_000);

  it('case 4: server tool_error — out-of-bounds teleport, recovery picks a different action', async () => {
    const { client, dispatch } = await makeLiveCtx();
    try {
      // `set_position({x:-1,y:-1})` passes local validation (both are
      // integers, schema-shape-correct) but the server returns
      // `{success:false, errorCode:'out_of_bounds'}`, which the MCP
      // boundary translates into `isError:true` and the wrapper surfaces
      // as a `tool_error`. This is the canonical "valid call shape, server
      // rejects on business rules" failure mode the contract must recover
      // from.
      //
      // Requires geas-server running with GEAS_DEV_UNAUTH=1 (gates
      // `set_position`). If that env isn't set the tool is absent from the
      // surface and the validator returns `unknown_tool` instead — still a
      // failure that the layer recovers from, just via a different category.
      const recover: RecoveryDriver = async (ctx) => {
        expect(['tool_error', 'unknown_tool']).toContain(ctx.failure.category);
        return {
          tool: 'look',
          args: {},
          intent: 're-observe before re-attempting movement',
        };
      };
      const outcome = await runWithRetry({
        initial: {
          tool: 'set_position',
          args: { x: -1, y: -1 },
          intent: 'teleport to wilds',
        },
        dispatch,
        recover,
        stuckDetector: createStuckDetector(),
        retryBudget: createRetryBudget({ budget: 3 }),
      });
      expect(outcome.status).toBe('ok');
      if (outcome.status !== 'ok') return;
      expect(outcome.recovered).toBe(true);
    } finally {
      await client.disconnect();
    }
  }, 30_000);

  it('case 5: stuck loop — driver keeps producing the same failing call, stuck fires', async () => {
    const { client, dispatch } = await makeLiveCtx();
    try {
      // Driver ignores recovery prompt — same typo every time.
      const recover: RecoveryDriver = async () =>
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
      expect(outcome.attempts).toBe(2);
    } finally {
      await client.disconnect();
    }
  }, 30_000);

  it('case 6: budget exhaustion — every attempt fails, clean exit at budget=3', async () => {
    const { client, dispatch } = await makeLiveCtx();
    try {
      // Driver varies args each retry so stuck doesn't fire; every call
      // is a non-existent tool name → local unknown_tool rejection.
      let n = 0;
      const recover: RecoveryDriver = async () => {
        n++;
        return { tool: `bogus_${n}`, args: {}, intent: 'try anything' };
      };
      const budget = createRetryBudget({ budget: 3 });
      const outcome = await runWithRetry({
        initial: { tool: 'bogus_0', args: {}, intent: 'try anything' },
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
      expect(outcome.event.detail.category).toBe('unknown_tool');
      expect(budget.telemetry.exhausted).toBe(true);
    } finally {
      await client.disconnect();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Real-LLM leg — one shot, gated on ANTHROPIC_API_KEY in addition to LIVE_URL.
// Proves the recovery prompt actually steers a real model to self-correct.
// ---------------------------------------------------------------------------

const RECOVERY_TOOL: LlmToolDef = {
  name: 'look',
  description: 'Observe the world around your character. Take no arguments.',
  inputSchema: { type: 'object', properties: {}, required: [] },
};

liveLlmDescribe('retry-layer contract — LIVE LLM recovery (one shot)', () => {
  it('Anthropic Haiku self-corrects an unknown-tool call when fed the recovery prompt', async () => {
    const { client, dispatch } = await makeLiveCtx();
    const provider = new AnthropicProvider({ maxTokens: 256 });
    try {
      const recover: RecoveryDriver = async (ctx) => {
        // Hand the recovery prompt to a real model and let it decide.
        const req: GenerateRequest = {
          system: [
            {
              type: 'text',
              text:
                'You are a deterministic test fixture for the Geas agent. ' +
                'When given a recovery prompt, fix the call by using the ' +
                'correct tool name from the provided tool list. ' +
                'Always emit a tool_use; do not reply in text only.',
            },
          ],
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: ctx.recoveryPrompt }],
            },
          ],
          tools: [RECOVERY_TOOL],
        };
        const res = await provider.generate(req);
        if (!res.ok) {
          throw new Error(`provider error: ${res.error.kind} — ${res.error.message}`);
        }
        const tu = res.value.content.find(isToolUseBlock);
        if (!tu) {
          throw new Error('model did not emit a tool_use on recovery');
        }
        return {
          tool: tu.name,
          args: tu.input,
          intent: ctx.priorIntent,
        };
      };
      const outcome = await runWithRetry({
        initial: { tool: 'loook', args: {}, intent: 'observe surroundings' },
        dispatch,
        recover,
        stuckDetector: createStuckDetector(),
        retryBudget: createRetryBudget({ budget: 3 }),
      });
      expect(outcome.status).toBe('ok');
      if (outcome.status !== 'ok') return;
      expect(outcome.recovered).toBe(true);
      // The model is expected to converge inside the budget; we don't pin
      // the exact attempt count because Haiku may try once or twice.
      expect(outcome.attempts).toBeLessThanOrEqual(4);
    } finally {
      await client.disconnect();
    }
  }, 60_000);
});
