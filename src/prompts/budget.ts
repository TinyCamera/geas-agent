/**
 * Retry budget — bounded retry counter per user-turn for the agent loop.
 * Sibling of #658 (validator), #659 (intent / recovery), #660 (stuck
 * detector) under the #586 validation & retry layer.
 *
 * **What "user-turn" means here.** One inbound message from the human to
 * the agent. Within that turn the loop may dispatch any number of
 * tool_use blocks; the budget caps how many of those are *retries*
 * (failed validator, failed MCP call, stuck-detector escalation). A
 * fresh user message resets the counter.
 *
 * **Why a separate primitive and not a counter inside the loop.** Three
 * call sites already need to bump the same counter — the validator
 * rejection path (#658), the MCP `tool_error` / transport path
 * (`GeasMcpClient.callTool`), and the stuck-detector escalation (#660).
 * Centralising it here gives the loop one record-and-check call, makes
 * the "default 3 / env override" policy live in one place, and produces
 * the exhaustion event in exactly one shape so the verification harness
 * can regress on it.
 *
 * **Default 3, env override `GEAS_AGENT_RETRY_BUDGET`.** Per the issue.
 * The default is intentionally aggressive — three retries inside one
 * user-turn means the model has had four chances total (the original
 * call + 3 retries) and is still failing. Past that, the cheap recovery
 * loop is no longer working; surface to the user. Higher budgets are
 * available via env when a human is actively debugging the loop.
 *
 * **Fail loudly.** When the budget is exhausted the next `recordRetry`
 * returns the `exhausted` event the loop is contracted to emit on
 * Channel A and then end the turn. Never silently no-op — the issue is
 * explicit about that, and the verification harness asserts the event
 * type.
 *
 * **Pure / single-process.** No timers, no I/O. Single in-memory
 * counter; the loop drives it explicitly.
 */

/** Default retry budget per user-turn when env override is absent / invalid. */
export const DEFAULT_RETRY_BUDGET = 3;

/** Env var name read by {@link readRetryBudgetFromEnv}. */
export const RETRY_BUDGET_ENV_VAR = 'GEAS_AGENT_RETRY_BUDGET';

/**
 * Parse the configured budget from the environment, falling back to the
 * default when the var is unset / empty / non-numeric / non-positive.
 *
 * We accept zero as a special value — it disables retries entirely (the
 * very first failure exhausts the budget). Negative or non-integer
 * inputs are programmer errors; we fall back rather than throw so a
 * misconfigured deploy still starts.
 */
export function readRetryBudgetFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[RETRY_BUDGET_ENV_VAR];
  if (raw === undefined || raw === '') return DEFAULT_RETRY_BUDGET;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return DEFAULT_RETRY_BUDGET;
  }
  return n;
}

/**
 * Shape-agnostic description of the failure that consumed a retry slot.
 * The loop hands this in on every `recordRetry`; the most recent one is
 * surfaced verbatim on the exhaustion event as `detail`.
 */
export interface RetryFailureDetail {
  /** Tool the agent was trying to call. */
  readonly tool: string;
  /**
   * Failure category — mirrors the validator / MCP error union so
   * telemetry can group exhausted-turn causes (`validator |
   * tool_error | transport | timeout | unknown_tool | stuck | other`).
   */
  readonly category: string;
  /** Human-readable one-line reason. Same string fed to the recovery prompt. */
  readonly reason: string;
}

/**
 * Channel A event the loop emits when the budget is exhausted. Shape is
 * locked by the issue spec — verification harness will assert on it.
 */
export interface RetryBudgetExhaustedEvent {
  readonly type: 'error';
  readonly kind: 'retry_budget_exhausted';
  /** Detail of the *last* failure that pushed the counter past budget. */
  readonly detail: RetryFailureDetail;
  /** Total retries that ran this turn — equals the configured budget. */
  readonly retries: number;
  /** Configured budget for context. Equal to `retries` at exhaustion. */
  readonly budget: number;
}

/**
 * Telemetry snapshot the loop can read at any point during / after a
 * turn. Hooked into the cost-telemetry channel so the verification
 * harness can regress on per-turn retry count.
 */
export interface RetryBudgetTelemetry {
  /** Configured budget for this tracker. */
  readonly budget: number;
  /** Number of retries consumed so far this turn. */
  readonly retries: number;
  /** True iff the next `recordRetry` would emit an exhausted event. */
  readonly exhausted: boolean;
}

export interface RetryBudget {
  /**
   * Record a retry. Returns `null` if the budget still has room, or the
   * exhausted event when this retry would push the counter past budget.
   *
   * The event is emitted on the call that *exhausts* the budget — the
   * loop is contracted to surface it and end the turn before issuing
   * any further tool calls.
   *
   * After exhaustion every subsequent `recordRetry` returns the same
   * event (with `retries` pinned at budget). The loop should not be
   * calling in that state, but we keep the contract idempotent so a
   * straggler call doesn't crash the process.
   */
  recordRetry(detail: RetryFailureDetail): RetryBudgetExhaustedEvent | null;
  /** Reset for a new user-turn. */
  onUserMessage(): void;
  /** Force-reset (equivalent to constructing a fresh tracker). */
  reset(): void;
  /** Read-only telemetry snapshot. */
  readonly telemetry: RetryBudgetTelemetry;
}

export interface CreateRetryBudgetOptions {
  /** Override the budget; defaults to {@link readRetryBudgetFromEnv}. */
  readonly budget?: number;
}

/**
 * Construct a retry-budget tracker. Reads the env at construction time —
 * the loop builds one tracker per process / agent instance and reuses
 * it across turns via `onUserMessage()`.
 *
 * Stateful, single-process, not thread-safe — the loop is single-threaded
 * so that's a non-issue.
 */
export function createRetryBudget(
  options: CreateRetryBudgetOptions = {},
): RetryBudget {
  const budget =
    options.budget !== undefined ? options.budget : readRetryBudgetFromEnv();
  if (!Number.isInteger(budget) || budget < 0) {
    // Programmer error — explicit override that's invalid. Throw rather
    // than silently fall back; the env path is the resilient one.
    throw new Error(
      `createRetryBudget: \`budget\` must be a non-negative integer, got ${String(budget)}`,
    );
  }

  let retries = 0;

  const buildExhaustedEvent = (
    detail: RetryFailureDetail,
  ): RetryBudgetExhaustedEvent => ({
    type: 'error',
    kind: 'retry_budget_exhausted',
    detail,
    retries: budget,
    budget,
  });

  return {
    recordRetry(detail: RetryFailureDetail): RetryBudgetExhaustedEvent | null {
      // budget=0 means "no retries allowed" — the first call exhausts.
      if (retries >= budget) {
        // Already exhausted from a prior call this turn — idempotent.
        retries = budget;
        return buildExhaustedEvent(detail);
      }
      retries += 1;
      if (retries >= budget) {
        return buildExhaustedEvent(detail);
      }
      return null;
    },
    onUserMessage(): void {
      retries = 0;
    },
    reset(): void {
      retries = 0;
    },
    get telemetry(): RetryBudgetTelemetry {
      return {
        budget,
        retries,
        exhausted: retries >= budget,
      };
    },
  };
}
