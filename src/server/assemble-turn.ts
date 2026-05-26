/**
 * Pure assembler: a sequence of `ChannelAEvent` frames → one `TurnResult`.
 *
 * Used by `POST /chat/sync` (issue #736) to give a test client the full
 * outcome of a single turn as a JSON body without making it speak the
 * streaming WS protocol. Also reusable from unit tests that drive event
 * sequences synthetically.
 *
 * The streaming wire is the canonical surface (REPL #648, web client
 * #592); `TurnResult` is a flattened convenience view over a finite
 * window of events. Out of necessity it is **lossy**: ordering between
 * categories is dropped (toolCalls and narration are surfaced as two
 * arrays, not interleaved), and `hello` / `ping` frames are filtered
 * out. The assembler is deliberately tolerant of malformed-but-survivable
 * sequences — see test cases for the rules.
 */

import type {
  ChannelAEvent,
  TelemetryEvent,
} from './wire.js';

export interface TurnResultToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
  readonly intent: string | null;
}

export interface TurnResultToolResult {
  readonly tool: string;
  readonly status: string;
  readonly attempts: number;
  readonly value?: unknown;
  readonly lastFailure?: unknown;
}

export interface TurnResultDecision {
  readonly decisionId: string;
  readonly payload: unknown;
}

/**
 * Server-emitted reasons the turn ended. Aligned with what the runner
 * actually emits via `LoopEmitEvent.done.reason` plus the synthetic
 * states the sync endpoint can produce (`error` if an `error` event was
 * seen with no `done`; `timeout` if the wait window elapsed before any
 * terminal frame).
 *
 * NOT aligned with Anthropic's `stop_reason` taxonomy — those are an
 * LLM-level detail; this is a Channel-A level detail.
 */
export type TurnStopReason = 'end_turn' | 'aborted' | 'error' | 'timeout';

export interface TurnResult {
  readonly userMessage: string;
  readonly assistantText: string;
  readonly toolCalls: ReadonlyArray<TurnResultToolCall>;
  readonly toolResults: ReadonlyArray<TurnResultToolResult>;
  readonly narration: ReadonlyArray<string>;
  readonly decisions: ReadonlyArray<TurnResultDecision>;
  /** Last telemetry frame in the window, or null if none. */
  readonly telemetry: TelemetryEvent | null;
  readonly stopReason: TurnStopReason;
  /** Populated when `stopReason === 'error'`. */
  readonly errorMessage?: string;
}

export interface AssembleOptions {
  /**
   * If true, treat the assembly as having timed out (no terminal `done`
   * was observed within the wait window). Sets `stopReason='timeout'`
   * unless an `error` frame was seen, in which case `'error'` wins.
   */
  readonly timedOut?: boolean;
}

/**
 * Fold a sequence of Channel-A wire events into a single `TurnResult`.
 *
 * Filtering:
 *   - `hello` and `ping` are skipped (transport noise, not turn content).
 *
 * Reductions:
 *   - `text` frames are concatenated in order (text deltas are additive).
 *   - `narration` frames are kept as separate strings (each is a distinct
 *     server-side narration block).
 *   - `telemetry` frames: only the **last** is retained (turns currently
 *     emit one aggregate; if a future change emits multiple, the caller
 *     should switch to the streaming surface).
 *
 * Terminal state:
 *   - First `done` frame wins; `stopReason = done.reason`.
 *   - If `timedOut: true` and no `done` seen → `'timeout'`.
 *   - If `error` frame seen and no `done` → `'error'` (with `errorMessage`).
 *   - If `error` frame seen *and* `done` seen → `done.reason` wins, but
 *     `errorMessage` is still populated for visibility.
 */
export function assembleTurn(
  userMessage: string,
  events: ReadonlyArray<ChannelAEvent>,
  opts: AssembleOptions = {},
): TurnResult {
  let assistantText = '';
  const toolCalls: TurnResultToolCall[] = [];
  const toolResults: TurnResultToolResult[] = [];
  const narration: string[] = [];
  const decisions: TurnResultDecision[] = [];
  let telemetry: TelemetryEvent | null = null;
  let doneReason: 'end_turn' | 'aborted' | null = null;
  let errorMessage: string | undefined;
  let toolCallSeq = 0;

  for (const e of events) {
    switch (e.type) {
      case 'hello':
      case 'ping':
        // Transport noise — skip.
        break;
      case 'text':
        assistantText += e.text;
        break;
      case 'tool_call':
        toolCalls.push({
          // The wire `tool_call` event does not carry a stable id today
          // (the runner's AttemptPlan does, but it isn't lifted onto the
          // wire). Synthesise a per-turn ordinal so callers can correlate
          // calls with results by position.
          id: `tc-${++toolCallSeq}`,
          name: e.tool,
          args: e.args,
          intent: e.intent,
        });
        break;
      case 'tool_result':
        toolResults.push({
          tool: e.tool,
          status: e.status,
          attempts: e.attempts,
          ...(e.value !== undefined ? { value: e.value } : {}),
          ...(e.lastFailure !== undefined ? { lastFailure: e.lastFailure } : {}),
        });
        break;
      case 'narration':
        narration.push(e.text);
        break;
      case 'decision':
        decisions.push({ decisionId: e.decisionId, payload: e.payload });
        break;
      case 'telemetry':
        telemetry = e;
        break;
      case 'error':
        errorMessage = e.message;
        break;
      case 'done':
        if (doneReason === null) doneReason = e.reason;
        break;
    }
  }

  const stopReason: TurnStopReason =
    doneReason !== null
      ? doneReason
      : errorMessage !== undefined
        ? 'error'
        : opts.timedOut
          ? 'timeout'
          : 'end_turn';

  return {
    userMessage,
    assistantText,
    toolCalls,
    toolResults,
    narration,
    decisions,
    telemetry,
    stopReason,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  };
}
