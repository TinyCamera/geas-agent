/**
 * Stuck detector — flags when the agent is wasting retries on the same
 * `(tool, args)` pair after it's already failed once. Sibling of #658
 * (validator) and #659 (intent / recovery) under the #586 validation &
 * retry layer.
 *
 * **What "stuck" means here.** The loop has a finite retry budget per
 * user-turn. We don't want it to burn that budget hammering an identical
 * call. The minimal, conservative signal: the *most recent* failed call
 * and the call immediately before it (in failure order) share the same
 * tool name and the same normalized arguments. That's enough to know the
 * model is not learning from the recovery prompt and the loop should
 * stop and ask the human.
 *
 * **Why "previous failure" and not "any prior matching failure".** The
 * issue spec says "same as the previous failed call" — adjacency in the
 * failure stream. A call that failed three turns ago, succeeded once
 * since, and now fails again is *not* stuck; the success in between
 * proves the agent can recover. The reset on success below enforces
 * that.
 *
 * **What resets the detector.**
 *   - Any successful tool call (`record({status:'ok'})`).
 *   - A new user message (`onUserMessage()`).
 *   - An explicit `reset()` (e.g. when the loop yields to the human).
 * Both clear the in-memory failure history so future stuck-checks start
 * from a clean slate.
 *
 * **Pure / single-process.** No timers, no persistence, no I/O — the
 * detector is a tiny state machine the loop drives explicitly. The loop
 * owns the decision of how to surface the stuck signal (Channel A
 * event, chat message, structured stderr) — this module only flags it.
 */

/** Stable hash of a normalized args object: sorted keys, JSON.stringify.
 *
 * Exported for the loop's in-memory turn record (the spec calls for
 * `{tool, argsHash, status}` tuples). We avoid a crypto hash on purpose:
 *   - The "hash" only needs equality semantics within one process — a
 *     canonical JSON string is exactly that, cheaper, and trivially
 *     debuggable when inspected.
 *   - We deep-sort keys so `{a:1,b:2}` and `{b:2,a:1}` collide; nested
 *     objects recurse, arrays preserve order (order is semantically
 *     significant for arg lists).
 *   - Non-JSON-able values (undefined, functions, symbols) are coerced
 *     to `null` so we don't throw on edge-case model output; the loop
 *     would have rejected those at the validator anyway.
 */
export function hashArgs(args: unknown): string {
  return JSON.stringify(canonicalize(args));
}

function canonicalize(v: unknown): unknown {
  if (v === null) return null;
  if (Array.isArray(v)) return v.map(canonicalize);
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = canonicalize(obj[k]);
    }
    return sorted;
  }
  if (typeof v === 'undefined' || typeof v === 'function' || typeof v === 'symbol') {
    return null;
  }
  // string / number / boolean / bigint — JSON.stringify handles the
  // first three; bigint we coerce to string to avoid a throw.
  if (typeof v === 'bigint') return v.toString();
  return v;
}

/** A single tool-call outcome the detector consumes. */
export interface ToolCallRecord {
  readonly tool: string;
  readonly args: unknown;
  readonly status: 'ok' | 'fail';
}

/** Snapshot of what the loop should surface when stuck fires. */
export interface StuckSignal {
  readonly tool: string;
  readonly argsHash: string;
  /** Number of consecutive identical failures (>=2 when fired). */
  readonly consecutiveFailures: number;
}

export interface StuckDetector {
  /**
   * Record a tool-call outcome. Returns a `StuckSignal` on the call that
   * pushes the detector into stuck state (i.e. the second-in-a-row
   * identical failure). Subsequent identical failures keep returning a
   * signal with an incremented `consecutiveFailures` so the loop can
   * decide whether to escalate further if it ignored the first signal.
   */
  record(call: ToolCallRecord): StuckSignal | null;
  /** Clear failure history (e.g. on a new user message). */
  onUserMessage(): void;
  /** Force-reset all state. Equivalent to constructing a fresh detector. */
  reset(): void;
  /**
   * Read-only view for telemetry/tests. `lastFailure` is null after any
   * reset / success / user-message.
   */
  readonly lastFailure: { tool: string; argsHash: string } | null;
}

/**
 * Construct a stuck detector. Stateful, single-process, not thread-safe —
 * the loop is single-threaded so that's a non-issue.
 */
export function createStuckDetector(): StuckDetector {
  let last: { tool: string; argsHash: string } | null = null;
  let consecutive = 0;

  return {
    record(call: ToolCallRecord): StuckSignal | null {
      if (call.status === 'ok') {
        // Success breaks the chain — even if a future call repeats the
        // same args, it's not "stuck" because the agent demonstrated
        // recovery in between.
        last = null;
        consecutive = 0;
        return null;
      }
      const argsHash = hashArgs(call.args);
      if (last && last.tool === call.tool && last.argsHash === argsHash) {
        consecutive += 1;
        // last remains the same (tool/hash unchanged); counter is monotonic
        // so "still stuck, escalate further" callers see it grow.
        return { tool: call.tool, argsHash, consecutiveFailures: consecutive };
      }
      // Different tool or different args → reset chain to this failure.
      last = { tool: call.tool, argsHash };
      consecutive = 1;
      return null;
    },
    onUserMessage(): void {
      last = null;
      consecutive = 0;
    },
    reset(): void {
      last = null;
      consecutive = 0;
    },
    get lastFailure() {
      return last;
    },
  };
}
