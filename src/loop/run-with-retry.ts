/**
 * runWithRetry — the validation+retry contract, composed.
 *
 * Wires the four sibling pieces of epic #586 into a single dispatcher the
 * agent loop (and the #662 integration tests) call once per tool intent:
 *
 *     [ validator ] -> [ MCP dispatch ] -> [ stuck detector ]
 *           |                |                      |
 *           +----- failure --+----------------------+
 *                            v
 *                  [ recovery prompt ]
 *                            v
 *                   [ retry budget? ]
 *                            v
 *           recover() -> next AttemptPlan, or null = give up
 *
 * Why this lives in its own module
 * --------------------------------
 *
 * Two consumers need the *same* glue: a future production agent loop, and
 * the integration tests that treat the layer as a contract (issue #662).
 * Folding the loop into the tests would mean every later loop has to
 * re-derive the assembly order, and the tests can't regress on the real
 * thing. One small composition function, two callers.
 *
 * What `runWithRetry` deliberately does NOT do
 * --------------------------------------------
 *
 *   - **Decide what the next attempt looks like.** That's the model's job
 *     (or a scripted driver in tests). The caller supplies `recover()`,
 *     which gets the recovery prompt + last failure and returns the next
 *     `AttemptPlan` (or `null` to give up cleanly).
 *
 *   - **Drive the LLM.** The recovery driver may call an `LlmProvider`,
 *     replay a script, or just return a hand-coded fix — `runWithRetry`
 *     doesn't care. Keeping the provider out of this composition means
 *     unit tests can run with zero LLM cost and the live integration
 *     tests can plug in a real provider only where it matters.
 *
 *   - **Yield to the human.** When the budget exhausts or we get stuck,
 *     we return a structured outcome and stop. The caller decides how
 *     to surface that (Channel A event, chat reply, structured stderr).
 *
 *   - **Multi-tool turns.** One call dispatches one tool with retries on
 *     the *same intent*. A user-turn that wants several tools calls
 *     `runWithRetry` once per intent, sharing the same `retryBudget` so
 *     the cross-tool retry cap is enforced.
 *
 * Stuck vs exhausted ordering
 * ---------------------------
 *
 * Stuck detection wins. The stuck detector fires on the *second*
 * identical-failure in a row, which is always before budget=3 exhausts.
 * Both paths could theoretically race; the implementation checks stuck
 * first because "I'm hammering the same broken call" is a more specific
 * (and more actionable) signal than "I ran out of retries" — telling the
 * user "tried the same thing twice" is better than "tried 3 times."
 */

import type { Result } from '../mcp/errors.js';
import type { GeasToolResponse } from '../mcp/tools.js';
import type { GeasMcpError } from '../mcp/errors.js';
import {
  buildRecoveryPrompt,
  type ToolCallFailure,
} from '../prompts/recovery.js';
import type { StuckDetector, StuckSignal } from '../prompts/stuck.js';
import type {
  RetryBudget,
  RetryBudgetExhaustedEvent,
  RetryFailureDetail,
} from '../prompts/budget.js';

/** One concrete attempt the runner is asked to dispatch. */
export interface AttemptPlan {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  /**
   * The intent the model declared this turn. Threaded through to the
   * recovery prompt so retries are framed against the goal, not the
   * mechanic. `null` means the model did not declare one — the recovery
   * prompt will nudge it to do so on the retry.
   */
  readonly intent: string | null;
}

/** Context handed to the recovery driver to produce the next attempt. */
export interface RecoveryContext {
  /** Shape-agnostic description of what just failed. */
  readonly failure: ToolCallFailure;
  /** The intent the prior attempt declared (or `null`). */
  readonly priorIntent: string | null;
  /** 1-indexed attempt number that just failed. */
  readonly attempt: number;
  /** The pre-built recovery prompt text the driver should feed the model. */
  readonly recoveryPrompt: string;
}

/**
 * Recovery driver — supplies the next `AttemptPlan` given a recovery
 * context, or `null` to give up. Async to accommodate live-LLM drivers.
 */
export type RecoveryDriver = (
  ctx: RecoveryContext,
) => Promise<AttemptPlan | null>;

export interface RunWithRetryInput {
  /** First attempt — what the model produced on the user-turn. */
  readonly initial: AttemptPlan;
  /** Dispatch a plan against the underlying client (typically `client.callTool`). */
  readonly dispatch: (plan: AttemptPlan) => Promise<Result<GeasToolResponse>>;
  /** Recovery driver producing the next attempt on failure. */
  readonly recover: RecoveryDriver;
  /** Shared stuck detector (typically one per agent process). */
  readonly stuckDetector: StuckDetector;
  /** Shared retry budget (typically one per user-turn). */
  readonly retryBudget: RetryBudget;
  /** Hard cap on attempts as a belt-and-braces guard (defaults to 16). */
  readonly maxAttempts?: number;
}

/** Successful tool call, possibly after one or more retries. */
export interface RunWithRetryOk {
  readonly status: 'ok';
  readonly value: GeasToolResponse;
  /** Total attempts (>=1). */
  readonly attempts: number;
  /** True iff the first attempt failed and at least one retry ran. */
  readonly recovered: boolean;
}

/** Stuck detector fired before we exhausted the budget. */
export interface RunWithRetryStuck {
  readonly status: 'stuck';
  readonly signal: StuckSignal;
  readonly lastFailure: ToolCallFailure;
  readonly attempts: number;
}

/** Retry budget hit — the loop must yield to the human. */
export interface RunWithRetryExhausted {
  readonly status: 'exhausted';
  readonly event: RetryBudgetExhaustedEvent;
  readonly lastFailure: ToolCallFailure;
  readonly attempts: number;
}

/** Recovery driver returned `null` — clean give-up. */
export interface RunWithRetryGaveUp {
  readonly status: 'gave_up';
  readonly lastFailure: ToolCallFailure;
  readonly attempts: number;
}

export type RunWithRetryOutcome =
  | RunWithRetryOk
  | RunWithRetryStuck
  | RunWithRetryExhausted
  | RunWithRetryGaveUp;

const DEFAULT_MAX_ATTEMPTS = 16;

/** Categorise an MCP error for the retry-budget telemetry / stuck signals. */
function categorize(e: GeasMcpError): string {
  return e.kind;
}

/** Convert an MCP error into the shape-agnostic `ToolCallFailure` the
 *  recovery prompt and budget consume. */
function toFailure(
  plan: AttemptPlan,
  e: GeasMcpError,
): ToolCallFailure {
  return {
    toolName: plan.tool,
    args: plan.args,
    reason: e.message,
    category: categorize(e),
  };
}

function toBudgetDetail(failure: ToolCallFailure): RetryFailureDetail {
  return {
    tool: failure.toolName,
    category: failure.category ?? 'other',
    reason: failure.reason,
  };
}

/**
 * Dispatch one tool intent through the retry-layer contract.
 *
 * Returns a structured outcome the caller surfaces to the user / loop.
 * The function itself never throws on a retryable condition; programmer
 * errors (missing `initial`, missing `dispatch`) throw immediately.
 */
export async function runWithRetry(
  input: RunWithRetryInput,
): Promise<RunWithRetryOutcome> {
  if (!input.initial) {
    throw new Error('runWithRetry: `initial` is required');
  }
  if (!input.dispatch) {
    throw new Error('runWithRetry: `dispatch` is required');
  }
  if (!input.recover) {
    throw new Error('runWithRetry: `recover` is required');
  }
  if (!input.stuckDetector) {
    throw new Error('runWithRetry: `stuckDetector` is required');
  }
  if (!input.retryBudget) {
    throw new Error('runWithRetry: `retryBudget` is required');
  }

  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  let plan = input.initial;
  let priorIntent = plan.intent;
  let attempts = 0;
  let lastFailure: ToolCallFailure | null = null;
  let firstFailed = false;

  while (attempts < maxAttempts) {
    attempts += 1;
    const res = await input.dispatch(plan);

    if (res.ok) {
      // Record success — resets stuck detector chain.
      input.stuckDetector.record({
        tool: plan.tool,
        args: plan.args,
        status: 'ok',
      });
      return {
        status: 'ok',
        value: res.value,
        attempts,
        recovered: firstFailed,
      };
    }

    // Failure path.
    firstFailed = true;
    const failure = toFailure(plan, res.error);
    lastFailure = failure;

    const stuck = input.stuckDetector.record({
      tool: plan.tool,
      args: plan.args,
      status: 'fail',
    });
    if (stuck) {
      // Stuck wins over budget — the loop should surface this immediately.
      return {
        status: 'stuck',
        signal: stuck,
        lastFailure: failure,
        attempts,
      };
    }

    // Consume a retry slot. Exhaustion ends the turn.
    const exhausted = input.retryBudget.recordRetry(toBudgetDetail(failure));
    if (exhausted) {
      return {
        status: 'exhausted',
        event: exhausted,
        lastFailure: failure,
        attempts,
      };
    }

    // Build the recovery prompt and ask the driver for the next attempt.
    const recoveryPrompt = buildRecoveryPrompt({
      failure,
      priorIntent,
    });
    const next = await input.recover({
      failure,
      priorIntent,
      attempt: attempts,
      recoveryPrompt,
    });
    if (!next) {
      return { status: 'gave_up', lastFailure: failure, attempts };
    }
    plan = next;
    priorIntent = next.intent;
  }

  // maxAttempts guard — treat as gave_up with the last failure attached.
  // This path should be unreachable in practice (budget exhaustion fires
  // first at budget=3) but the guard keeps a runaway loop bounded.
  return {
    status: 'gave_up',
    lastFailure: lastFailure ?? {
      toolName: plan.tool,
      args: plan.args,
      reason: 'maxAttempts reached without dispatch',
      category: 'other',
    },
    attempts,
  };
}
