/**
 * Per-character loop state machine — pure reducer.
 *
 * **Why a reducer, not a class with side-effects.** The runner (`runner.ts`)
 * owns the wiring to the LLM, MCP, and retry layer; this file is the audit
 * trail of *what is allowed to happen next*. Keeping it pure means:
 *
 *   1. Every transition is one line in a table — easy to argue about, easy
 *      to exhaustively unit-test.
 *   2. Two runners (production loop + integration-test driver) share the
 *      same state model. If they disagree, only one of them is wrong.
 *   3. Replay / record-and-replay traces work for free: a list of
 *      `(state, event) → newState` pairs is the entire turn.
 *
 * **States (per issue #663).**
 *
 *   - `idle` — no active turn. Initial state and the resting point between
 *     user turns. Only `user-message` advances it.
 *   - `awaiting-llm` — a `generate` request is in flight (or about to be).
 *   - `dispatching-tool` — model returned a `tool_use`; runner is about to
 *     dispatch through the retry layer. Transient — collapses immediately to
 *     `awaiting-server` once the dispatch begins. Modeled separately so a
 *     trace can show *the model chose tool X* distinctly from *we're waiting
 *     on the server*.
 *   - `awaiting-server` — the MCP call (or a Channel-B decision push) is
 *     in flight.
 *   - `narrating` — the final assistant turn (no further tool_use) is being
 *     streamed to the user.
 *   - `done` — terminal success. The user-turn finished cleanly.
 *   - `error` — terminal failure. The runner has surfaced (or will surface)
 *     an `error` event to Channel A and the turn is over.
 *
 * **Events the machine accepts** (a strict superset of what the runner
 * actually consumes today — Channel-B `decision-needed-from-server` and
 * `user-disconnected` are wired in shape now so the runner doesn't need a
 * later state-machine bump when those land).
 *
 * **What the machine deliberately does NOT model.**
 *
 *   - Retries. The retry layer (`run-with-retry.ts`) sits *under* the
 *     `awaiting-server` state; from this machine's perspective a tool call
 *     either resolves or errors, regardless of how many attempts that took.
 *   - Token-by-token text deltas. Streaming is a runner concern — the
 *     state machine only observes the terminal `llm-response`.
 *   - Multi-tool turns. A turn that wants several tools cycles
 *     `awaiting-llm → dispatching-tool → awaiting-server → awaiting-llm`
 *     N times naturally; no extra state is needed.
 */

/** Discrete machine states. */
export type LoopState =
  | 'idle'
  | 'awaiting-llm'
  | 'dispatching-tool'
  | 'awaiting-server'
  | 'narrating'
  | 'done'
  | 'error';

/**
 * Coarse description of an LLM response — enough for the reducer to choose
 * the next state. Concrete content (text blocks, tool args) is the runner's
 * to keep, not the state machine's.
 */
export type LlmStop = 'tool_use' | 'end_turn' | 'max_tokens' | 'stop_sequence';

/** Events the state machine accepts. */
export type LoopEvent =
  | { readonly kind: 'user-message' }
  | { readonly kind: 'llm-response'; readonly stop: LlmStop }
  | { readonly kind: 'tool-result' }
  | { readonly kind: 'tool-error' }
  | { readonly kind: 'decision-needed-from-server' }
  | { readonly kind: 'decision-resolved' }
  | { readonly kind: 'narration-complete' }
  | { readonly kind: 'fatal-error' }
  | { readonly kind: 'user-disconnected' };

/**
 * One transition. `next === current` is fine — see e.g. `awaiting-llm` on a
 * `max_tokens` stop, where the runner records the truncation and re-prompts.
 *
 * Illegal transitions return an explicit `{ ok: false }` instead of throwing,
 * so the runner can decide whether to log + recover or surface an error.
 * (`reduce()` does throw on illegal — see below — but `tryReduce()` doesn't.)
 */
export interface TransitionOk {
  readonly ok: true;
  readonly next: LoopState;
}
export interface TransitionErr {
  readonly ok: false;
  readonly reason: string;
}
export type Transition = TransitionOk | TransitionErr;

/** Non-throwing variant. Returns `{ ok: false }` for illegal pairs. */
export function tryReduce(state: LoopState, event: LoopEvent): Transition {
  // Universal terminal triggers — apply before per-state logic so a
  // disconnect or fatal error always wins, no matter where we are.
  if (event.kind === 'user-disconnected' || event.kind === 'fatal-error') {
    if (state === 'done' || state === 'error') {
      // Already terminal — idempotent.
      return { ok: true, next: 'error' };
    }
    return { ok: true, next: 'error' };
  }

  switch (state) {
    case 'idle': {
      if (event.kind === 'user-message') return { ok: true, next: 'awaiting-llm' };
      return illegal(state, event);
    }

    case 'awaiting-llm': {
      if (event.kind === 'llm-response') {
        if (event.stop === 'tool_use') {
          return { ok: true, next: 'dispatching-tool' };
        }
        if (
          event.stop === 'end_turn' ||
          event.stop === 'stop_sequence' ||
          event.stop === 'max_tokens'
        ) {
          // `max_tokens` is technically partial output but for the
          // state-machine's purposes the model handed back control; the
          // runner decides whether to re-prompt or surface as-is.
          return { ok: true, next: 'narrating' };
        }
        return illegal(state, event);
      }
      return illegal(state, event);
    }

    case 'dispatching-tool': {
      // Transient. The runner advances to awaiting-server as soon as it
      // hands the AttemptPlan to runWithRetry. We accept the synthetic
      // `tool-result`/`tool-error` here too in case a dispatcher resolves
      // synchronously in tests.
      if (event.kind === 'tool-result') return { ok: true, next: 'awaiting-llm' };
      if (event.kind === 'tool-error') return { ok: true, next: 'awaiting-llm' };
      if (event.kind === 'decision-needed-from-server') {
        return { ok: true, next: 'awaiting-server' };
      }
      // No event to "advance" to awaiting-server explicitly — that's a
      // synchronous step in the runner. But we accept a no-op trigger
      // shaped as an llm-response with stop=tool_use re-entry for
      // multi-tool turns the runner unwinds without going back to the LLM.
      return { ok: true, next: 'awaiting-server' };
    }

    case 'awaiting-server': {
      if (event.kind === 'tool-result') {
        // Feed the result back to the model.
        return { ok: true, next: 'awaiting-llm' };
      }
      if (event.kind === 'tool-error') {
        // The retry layer below us either recovered (in which case we'd
        // see `tool-result` instead) or surfaced an exhausted/stuck
        // outcome. The runner translates that to `tool-error` here and
        // we hand back to the LLM with the error in tool_result content.
        return { ok: true, next: 'awaiting-llm' };
      }
      if (event.kind === 'decision-needed-from-server') {
        // Already waiting — staying put is fine (idempotent push).
        return { ok: true, next: 'awaiting-server' };
      }
      if (event.kind === 'decision-resolved') {
        return { ok: true, next: 'awaiting-llm' };
      }
      return illegal(state, event);
    }

    case 'narrating': {
      if (event.kind === 'narration-complete') {
        return { ok: true, next: 'done' };
      }
      // Tolerate a server push during narration — the runner queues it
      // and we re-enter awaiting-server on the next turn.
      if (event.kind === 'decision-needed-from-server') {
        return { ok: true, next: 'awaiting-server' };
      }
      return illegal(state, event);
    }

    case 'done':
    case 'error': {
      // Terminal — only fatal-error / user-disconnected (handled above)
      // can change anything. A new `user-message` starts a fresh
      // *machine instance*; the runner should mint one, not feed this
      // one a new user-message.
      return illegal(state, event);
    }
  }
}

function illegal(state: LoopState, event: LoopEvent): TransitionErr {
  return {
    ok: false,
    reason: `illegal transition: ${state} + ${event.kind}`,
  };
}

/**
 * Throwing variant — convenient in the runner where an illegal transition
 * is a programmer error, not a runtime condition.
 */
export function reduce(state: LoopState, event: LoopEvent): LoopState {
  const t = tryReduce(state, event);
  if (!t.ok) {
    throw new Error(`state-machine: ${t.reason}`);
  }
  return t.next;
}

/** Terminal-state predicate. The runner uses this to know when to stop. */
export function isTerminal(state: LoopState): boolean {
  return state === 'done' || state === 'error';
}

/** Initial state — exported so the runner doesn't have to know the literal. */
export const INITIAL_STATE: LoopState = 'idle';
