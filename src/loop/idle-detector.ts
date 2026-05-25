/**
 * Idle detector — pure computation of "is this agent idle right now?".
 *
 * **Why a pure function, not a timer.** The `IdleSession` (`session.ts`)
 * owns the wall-clock and the wake/sleep wiring; this file is just the
 * predicate. Keeping it pure means:
 *
 *   1. The transition table is table-testable — every combination of inputs
 *      maps to one boolean output, no fakes needed.
 *   2. The session can ask `isIdle(now)` at any cadence (event-driven on
 *      message arrival, or polled every N seconds) and get the same answer.
 *   3. Replay traces work — feed a recorded `(now, inputs)` stream through
 *      `isIdle` and you get an identical idle/wake timeline.
 *
 * **Idleness rule (per issue #664).**
 *
 * Idle ⇔ all of:
 *   - No user message in the last `idleThresholdMs` (default 30s).
 *   - No in-flight tool calls.
 *   - No pending server-pushed decision.
 *
 * If any one of those is false, the agent is *active* — the runner may be
 * mid-turn, awaiting an MCP response, or holding a queued decision.
 *
 * **What this does NOT decide.**
 *
 *   - Whether to release the LLM provider client lease. The session owns
 *     that — it observes the idle transition and runs `onSleep`.
 *   - Whether the user is "connected". User-connection state is upstream
 *     (transport layer); from this detector's view, "no recent user
 *     message" is the same shape as "user disconnected".
 */

/** Inputs to `isIdle`. All timestamps are millis since epoch. */
export interface IdleInputs {
  /**
   * Wall-clock now (millis). Injected rather than read from `Date.now()`
   * so tests are deterministic.
   */
  readonly now: number;
  /**
   * Last time a user message was received. `null` means "no user message
   * ever in this session" — treated the same as "long ago".
   */
  readonly lastUserMessageAt: number | null;
  /**
   * Count of MCP/tool dispatches currently in flight. Any positive value
   * keeps the agent active — we don't want to sleep mid-tool-call.
   */
  readonly inFlightToolCalls: number;
  /**
   * True iff a server-pushed decision is queued but not yet resolved.
   * Pending decisions block idle so the runner can surface them as soon
   * as a wake fires.
   */
  readonly pendingDecision: boolean;
  /**
   * Quiet window before we count as idle. Default 30s per issue #664.
   * Override on construction for tests / aggressive prod tuning.
   */
  readonly idleThresholdMs: number;
}

export interface IdleVerdict {
  readonly isIdle: boolean;
  /** Seconds since the last user message — useful for telemetry. */
  readonly secondsSinceUserMessage: number;
  /** Why we're not idle, if we're not. `null` when `isIdle === true`. */
  readonly activeReason:
    | 'recent-user-message'
    | 'in-flight-tool-call'
    | 'pending-decision'
    | null;
}

const NEVER = Number.POSITIVE_INFINITY;

/** Pure: does the input describe an idle agent right now? */
export function isIdle(inputs: IdleInputs): IdleVerdict {
  const secondsSinceUserMessage =
    inputs.lastUserMessageAt === null
      ? NEVER
      : (inputs.now - inputs.lastUserMessageAt) / 1000;

  if (inputs.inFlightToolCalls > 0) {
    return {
      isIdle: false,
      secondsSinceUserMessage,
      activeReason: 'in-flight-tool-call',
    };
  }
  if (inputs.pendingDecision) {
    return {
      isIdle: false,
      secondsSinceUserMessage,
      activeReason: 'pending-decision',
    };
  }
  if (
    inputs.lastUserMessageAt !== null &&
    inputs.now - inputs.lastUserMessageAt < inputs.idleThresholdMs
  ) {
    return {
      isIdle: false,
      secondsSinceUserMessage,
      activeReason: 'recent-user-message',
    };
  }
  return {
    isIdle: true,
    secondsSinceUserMessage,
    activeReason: null,
  };
}

/** Default idle threshold (issue #664: 30s). */
export const DEFAULT_IDLE_THRESHOLD_MS = 30_000;
