/**
 * Per-character idle/wake session (issue #664).
 *
 * **Why this layer exists.** `LoopRunner` (`runner.ts`) runs one user-turn
 * end-to-end and goes terminal (`done` / `error`). It has no concept of
 * "what to do between turns". `IdleSession` is the long-lived owner above
 * the runner that:
 *
 *   1. Waits for wake events — `user-message` (Channel A) or
 *      `decision-needed-from-server` (Channel B push).
 *   2. Mints a fresh `LoopRunner` per turn and drives it.
 *   3. After the turn, slips back into idle, releases the LLM provider
 *      lease (`onSleep` hook — Firestore persistence lands in #592),
 *      and waits again.
 *   4. Tracks idle telemetry (`idleSecondsPerHour`) so the deploy can
 *      verify *idle agents consume no LLM tokens* — the issue's headline
 *      acceptance criterion.
 *
 * **What this layer is NOT.**
 *
 *   - It is not a multi-character orchestrator. One session = one
 *     character. A user with two characters has two sessions.
 *   - It does not own the transport. Channel A / Channel B wiring is the
 *     outer transport's job (websocket bridge, Colyseus listener). This
 *     session exposes `deliverUserMessage()` and `deliverDecision()` as
 *     entry points; the transport calls them.
 *   - It does not persist conversation state itself. The `onSleep` /
 *     `onWake` hooks are the seam — #592 (firestore-conversation-history)
 *     wires real persistence; for #664 the hooks are pluggable but
 *     default to no-ops.
 *
 * **Server push.** The wire-up (which geas-server events trigger
 * `deliverDecision`, on which transport) is deliberately out of scope —
 * it depends on a server-side change (Colyseus broadcast or new MCP
 * subscription tool) that's filed separately. From this session's view,
 * `deliverDecision()` is the single entry — it does not care whether the
 * transport upstream is a Colyseus room subscription, an MCP
 * `subscribe-decisions` long-poll, or a synthetic test injector.
 */

import {
  DEFAULT_IDLE_THRESHOLD_MS,
  isIdle,
  type IdleVerdict,
} from './idle-detector.js';
import type { LoopEmitter, LoopRunner } from './runner.js';

/** Clock injection — tests pass a fake clock; prod uses `Date.now`. */
export interface SessionClock {
  now(): number;
}

/** Default clock — wraps `Date.now()`. */
export const SYSTEM_CLOCK: SessionClock = {
  now: () => Date.now(),
};

/**
 * Hooks the session calls on the idle/wake transitions. All optional —
 * default no-ops. #592 will wire `onSleep` to "snapshot conversation to
 * Firestore + release provider lease" and `onWake` to "restore from
 * Firestore + reacquire lease".
 */
export interface SessionHooks {
  readonly onSleep?: () => void | Promise<void>;
  readonly onWake?: (cause: WakeCause) => void | Promise<void>;
}

export type WakeCause =
  | { readonly kind: 'user-message'; readonly text: string }
  | {
      readonly kind: 'decision';
      readonly decisionId: string;
      readonly payload: unknown;
    };

export interface SessionOptions {
  /**
   * Mints a fresh runner per user-turn. The session needs a *new* runner
   * each turn because `LoopRunner` ends in a terminal state — it can't
   * be reused. Wiring per-turn (system prompt, tools, hooks, emitter)
   * lives in this factory at the caller's discretion.
   */
  readonly runnerFactory: () => LoopRunner;
  /**
   * Channel-A events from the active runner pass through this emitter so
   * the outer transport gets one stable subscription per session, not one
   * per turn.
   */
  readonly emit: LoopEmitter;
  /** Quiet window before idle (default 30s, per issue #664). */
  readonly idleThresholdMs?: number;
  /** Wall-clock injection (default: system clock). */
  readonly clock?: SessionClock;
  /** Sleep/wake hooks (default: no-ops). */
  readonly hooks?: SessionHooks;
}

/** Telemetry snapshot — what the issue's acceptance criterion needs. */
export interface SessionTelemetry {
  /**
   * Total seconds spent idle in the last 1-hour window. Bounded to
   * `[0, 3600]`. Updated continuously; reads are instantaneous.
   */
  readonly idleSecondsPerHour: number;
  /** Total turns the session has driven since construction. */
  readonly turnsCompleted: number;
  /** Whether the session is currently idle (per `isIdle`). */
  readonly isIdle: boolean;
  /** Cumulative wake events. */
  readonly wakes: number;
}

/** Internal interval record for the rolling-hour calculation. */
interface IdleInterval {
  readonly startedAt: number;
  endedAt: number | null; // null while still idle
}

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Long-lived per-character session. Construct once at character bind, call
 * `deliverUserMessage` / `deliverDecision` from the transport, observe
 * `telemetry()` for the idle accounting.
 */
export class IdleSession {
  #opts: SessionOptions;
  #clock: SessionClock;
  #idleThresholdMs: number;

  // Mutable runtime state.
  #lastUserMessageAt: number | null = null;
  #inFlightToolCalls = 0;
  #pendingDecision: { id: string; payload: unknown } | null = null;
  #activeRunner: LoopRunner | null = null;
  #activeTurn: Promise<void> | null = null;

  // Idle-state bookkeeping for telemetry.
  #idleIntervals: IdleInterval[] = [];
  #currentIdleStartedAt: number;
  #turnsCompleted = 0;
  #wakes = 0;

  #closed = false;

  constructor(opts: SessionOptions) {
    this.#opts = opts;
    this.#clock = opts.clock ?? SYSTEM_CLOCK;
    this.#idleThresholdMs = opts.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
    // Session starts idle.
    this.#currentIdleStartedAt = this.#clock.now();
  }

  /**
   * Channel-A entry. Wakes the session, mints a runner, drives the turn
   * end-to-end. Returns when the turn lands in a terminal state.
   *
   * Concurrent calls are serialised — the second call waits for the first
   * to finish, then runs. (A correct transport shouldn't issue concurrent
   * user messages for one character anyway, but we serialise defensively.)
   */
  async deliverUserMessage(text: string): Promise<void> {
    if (this.#closed) throw new Error('IdleSession: closed');

    // Serialise — wait for any in-flight turn.
    while (this.#activeTurn) await this.#activeTurn;

    const now = this.#clock.now();
    this.#closeIdleInterval(now);
    this.#lastUserMessageAt = now;
    this.#wakes += 1;
    await this.#opts.hooks?.onWake?.({ kind: 'user-message', text });

    const runner = this.#opts.runnerFactory();
    this.#activeRunner = runner;
    this.#inFlightToolCalls = 0; // fresh per turn

    const turn = this.#runTurn(runner, text);
    this.#activeTurn = turn;
    try {
      await turn;
    } finally {
      this.#activeRunner = null;
      this.#activeTurn = null;
      this.#turnsCompleted += 1;
      // If a decision was pushed during the turn, surface it now —
      // otherwise drop into idle.
      const decision = this.#pendingDecision;
      if (decision) {
        // Re-wake immediately for the decision.
        this.#pendingDecision = null;
        // Fire-and-forget the decision wake so callers of
        // deliverUserMessage don't block on an unrelated push.
        void this.#wakeForDecision(decision.id, decision.payload);
      } else {
        await this.#enterIdle();
      }
    }
  }

  /**
   * Channel-B entry. A server-pushed decision arrived. Wakes the session
   * (or queues against an in-flight turn). The session does NOT block on
   * the resulting turn — the push is fire-and-forget from the transport's
   * view; the runner's emitter is how the result reaches the user.
   */
  deliverDecision(decisionId: string, payload: unknown): void {
    if (this.#closed) return;

    if (this.#activeRunner) {
      // Mid-turn — hand to runner and let it surface.
      this.#activeRunner.pushDecisionRequest(decisionId, payload);
      // We still mark `pendingDecision` so after-turn logic resolves it
      // (the runner currently has no Channel-A emit for queued decisions
      // post-turn; we route through a fresh runner if needed).
      this.#pendingDecision = { id: decisionId, payload };
      return;
    }

    void this.#wakeForDecision(decisionId, payload);
  }

  /**
   * Read-only telemetry snapshot. Cheap — computes the rolling-hour sum
   * on demand from the (small) interval list.
   */
  telemetry(): SessionTelemetry {
    const now = this.#clock.now();
    const cutoff = now - ONE_HOUR_MS;

    // Sum idle seconds within the last hour, clamping intervals to the
    // rolling window. Include the currently-open interval if we're idle.
    let totalMs = 0;
    for (const interval of this.#idleIntervals) {
      const end = interval.endedAt ?? now;
      const start = Math.max(interval.startedAt, cutoff);
      if (end > start) totalMs += end - start;
    }
    if (this.#isCurrentlyIdle()) {
      const start = Math.max(this.#currentIdleStartedAt, cutoff);
      if (now > start) totalMs += now - start;
    }
    // Clamp to [0, 3600s].
    const idleSecondsPerHour = Math.max(0, Math.min(3600, totalMs / 1000));

    return {
      idleSecondsPerHour,
      turnsCompleted: this.#turnsCompleted,
      isIdle: this.#isCurrentlyIdle(),
      wakes: this.#wakes,
    };
  }

  /** Force a verdict read — useful for tests + telemetry exporters. */
  idleVerdict(): IdleVerdict {
    return isIdle({
      now: this.#clock.now(),
      lastUserMessageAt: this.#lastUserMessageAt,
      inFlightToolCalls: this.#inFlightToolCalls,
      pendingDecision: this.#pendingDecision !== null,
      idleThresholdMs: this.#idleThresholdMs,
    });
  }

  /** Tear-down. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#activeTurn) await this.#activeTurn;
    this.#closeIdleInterval(this.#clock.now());
  }

  // ----- internals -----

  #isCurrentlyIdle(): boolean {
    return this.idleVerdict().isIdle;
  }

  async #runTurn(runner: LoopRunner, userMessage: string): Promise<void> {
    // The runner emits through its own emitter; the session forwards via
    // a shared emitter wired in `runnerFactory`. We track inFlightToolCalls
    // by inspecting the runner state — but tooling-level accounting is
    // approximate; the idle detector cares about "any in-flight ⇒ active".
    this.#inFlightToolCalls = 1; // mark active for the duration of the turn
    try {
      await runner.start(userMessage);
    } finally {
      this.#inFlightToolCalls = 0;
    }
  }

  async #wakeForDecision(decisionId: string, payload: unknown): Promise<void> {
    // Wait for any in-flight turn to drain.
    while (this.#activeTurn) await this.#activeTurn;

    if (this.#closed) return;

    const now = this.#clock.now();
    this.#closeIdleInterval(now);
    this.#wakes += 1;
    this.#pendingDecision = { id: decisionId, payload };
    await this.#opts.hooks?.onWake?.({
      kind: 'decision',
      decisionId,
      payload,
    });

    // Spin up a fresh runner and surface the decision as the synthetic
    // first user-turn input. The runner's own pushDecisionRequest +
    // resolveDecision pair is the in-turn mechanism; for *waking from
    // idle on a server push* the simplest contract is "treat the decision
    // as the user-turn opening message and let the model react".
    const runner = this.#opts.runnerFactory();
    this.#activeRunner = runner;
    this.#inFlightToolCalls = 0;

    const framed = `[server decision ${decisionId}] ${
      typeof payload === 'string' ? payload : JSON.stringify(payload)
    }`;
    const turn = this.#runTurn(runner, framed);
    this.#activeTurn = turn;
    try {
      await turn;
    } finally {
      this.#activeRunner = null;
      this.#activeTurn = null;
      this.#turnsCompleted += 1;
      this.#pendingDecision = null;
      await this.#enterIdle();
    }
  }

  async #enterIdle(): Promise<void> {
    if (this.#closed) return;
    this.#currentIdleStartedAt = this.#clock.now();
    this.#idleIntervals.push({
      startedAt: this.#currentIdleStartedAt,
      endedAt: null,
    });
    // Prune anything older than 1h to keep the array bounded.
    this.#pruneOldIntervals();
    await this.#opts.hooks?.onSleep?.();
  }

  #closeIdleInterval(now: number): void {
    const open = this.#idleIntervals[this.#idleIntervals.length - 1];
    if (open && open.endedAt === null) {
      open.endedAt = now;
    }
  }

  #pruneOldIntervals(): void {
    const cutoff = this.#clock.now() - ONE_HOUR_MS;
    // Drop fully-elapsed intervals that ended before the cutoff.
    this.#idleIntervals = this.#idleIntervals.filter(
      (i) => i.endedAt === null || i.endedAt >= cutoff,
    );
  }
}
