/**
 * Per-character loop runner.
 *
 * Wires the (pure) state machine (`state-machine.ts`) to the LLM provider
 * (`src/llm`), the MCP dispatcher (the caller — see below), and the retry
 * layer (`run-with-retry.ts`). One `LoopRunner` instance drives one
 * character; multiple characters per user = multiple runners.
 *
 * **Why the runner does not import `GeasMcpClient` directly.** The MCP
 * dispatch surface here is just a `(plan) => Result<GeasToolResponse>`
 * function so:
 *
 *   - Tests don't need to spin up a real client (or a real server).
 *   - Production wiring passes `client.callTool` (or a wrapper that
 *     records telemetry / pins a UID) without the runner caring.
 *   - The retry layer already takes the same dispatch shape, so we just
 *     forward it through `runWithRetry`.
 *
 * **What the runner is responsible for.**
 *
 *   1. Translating model `tool_use` blocks into `AttemptPlan`s and feeding
 *      them through `runWithRetry`. The retry layer owns budget / stuck /
 *      recovery-prompt; we just observe the outcome.
 *   2. Building the conversation context (the rolling `messages` array)
 *      across model turns and threading the previous tool result back
 *      into the next request as a `tool_result` content block.
 *   3. Emitting Channel-A events (`text-delta`, `tool-call`, `tool-result`,
 *      `narration`, `decision`, `error`, `done`) via an observer the
 *      caller passes in. The wire format is up to the caller — we hand
 *      structured records, not strings.
 *   4. Advancing the state machine on every transition for traceability.
 *      The runner's behaviour is *defined* by the machine — anywhere the
 *      machine returns `error`, the runner stops.
 *
 * **What the runner is NOT responsible for.**
 *
 *   - Channel-B push handling. The runner exposes `pushDecisionRequest()`
 *     and `resolveDecision()` as Channel-B entry points so an outer
 *     transport (Colyseus listener, WS bridge) can deliver them. Stub
 *     implementations are sufficient for #663 — the live wiring lands
 *     with the rest of #587.
 *   - Multi-character orchestration. One runner = one character.
 */

import {
  isTextBlock,
  isToolUseBlock,
  type ContentBlock,
  type GenerateRequest,
  type GenerateResult,
  type LlmMessage,
  type LlmProvider,
  type LlmToolDef,
  type StopReason,
  type ToolUseBlock,
} from '../llm/provider.js';
import type { Result } from '../mcp/errors.js';
import type { GeasToolResponse } from '../mcp/tools.js';
import {
  runWithRetry,
  type AttemptPlan,
  type RecoveryDriver,
  type RunWithRetryOutcome,
} from './run-with-retry.js';
import type { StuckDetector } from '../prompts/stuck.js';
import type { RetryBudget } from '../prompts/budget.js';
import {
  INITIAL_STATE,
  isTerminal,
  reduce,
  type LoopEvent,
  type LoopState,
  type LlmStop,
} from './state-machine.js';

/**
 * Channel-A events emitted by the runner. Open-ended union so downstream
 * transports (WS, EventSource) can wire whichever they need without
 * forcing every event through every transport.
 */
export type LoopEmitEvent =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'tool-call'; readonly plan: AttemptPlan }
  | {
      readonly type: 'tool-result';
      readonly tool: string;
      readonly outcome: RunWithRetryOutcome;
    }
  | { readonly type: 'narration'; readonly text: string }
  | {
      readonly type: 'decision';
      readonly decisionId: string;
      readonly payload: unknown;
    }
  | { readonly type: 'error'; readonly message: string; readonly cause?: unknown }
  | { readonly type: 'done'; readonly reason: 'end_turn' | 'aborted' };

export type LoopEmitter = (event: LoopEmitEvent) => void;

/** What the runner needs to start. */
export interface LoopRunnerOptions {
  readonly llm: LlmProvider;
  readonly dispatch: (plan: AttemptPlan) => Promise<Result<GeasToolResponse>>;
  readonly stuckDetector: StuckDetector;
  readonly retryBudget: RetryBudget;
  readonly recover: RecoveryDriver;
  readonly tools: readonly LlmToolDef[];
  readonly system?: readonly { readonly type: 'text'; readonly text: string }[];
  readonly emit: LoopEmitter;
  /** Hard cap on LLM round-trips per user-turn (defaults to 8). */
  readonly maxTurns?: number;
}

const DEFAULT_MAX_TURNS = 8;

/**
 * Drives one character. Call `start(userMessage)` to kick off a turn; the
 * promise resolves when the turn reaches a terminal state (`done` or
 * `error`). Concurrent `start` calls on the same runner are not supported
 * — the caller should serialise per-character.
 */
export class LoopRunner {
  #opts: LoopRunnerOptions;
  #state: LoopState = INITIAL_STATE;
  #messages: LlmMessage[] = [];
  #pendingDecision: { id: string; payload: unknown } | null = null;

  constructor(opts: LoopRunnerOptions) {
    this.#opts = opts;
  }

  /** Read-only view of the current state — primarily for tests + telemetry. */
  get state(): LoopState {
    return this.#state;
  }

  /** Read-only view of the conversation buffer (tests inspect this). */
  get messages(): readonly LlmMessage[] {
    return this.#messages;
  }

  /**
   * Prepend prior `LlmMessage`s to the conversation buffer before `start`
   * is called. Used by `IdleSession` to seed a fresh runner with a
   * previously-persisted session's history (#650 session resume).
   *
   * **Why a separate seed call.** A turn's `start()` only accepts the
   * incoming user message — it can't double as the bootstrap entry
   * without losing the "one fresh turn per `start`" invariant. Seeding
   * is an explicit pre-step the caller controls.
   *
   * Throws if called after the runner has already advanced past `idle`,
   * to avoid silently corrupting an in-flight conversation.
   */
  seedMessages(msgs: readonly LlmMessage[]): void {
    if (this.#state !== 'idle') {
      throw new Error(
        `LoopRunner.seedMessages: runner is in state '${this.#state}' — seed before start`,
      );
    }
    for (const m of msgs) {
      this.#messages.push(m);
    }
  }

  /**
   * Channel-B entry — the outer transport calls this when geas-server pushes
   * a decision request. The runner queues it; the next time we land in
   * `awaiting-server` (or finish the current LLM turn) we surface it.
   * Stub for #663 — full Channel-B wiring lands with #587 siblings.
   */
  pushDecisionRequest(decisionId: string, payload: unknown): void {
    this.#pendingDecision = { id: decisionId, payload };
    this.#advance({ kind: 'decision-needed-from-server' });
  }

  /**
   * Channel-B entry — the user (or auto-resolver) decided. The payload is
   * threaded back into the conversation as a user-role message so the
   * model has the resolution in context.
   */
  resolveDecision(text: string): void {
    if (!this.#pendingDecision) return;
    this.#messages.push({
      role: 'user',
      content: [{ type: 'text', text }],
    });
    this.#pendingDecision = null;
    this.#advance({ kind: 'decision-resolved' });
  }

  /**
   * Run one user-turn end-to-end. Resolves when the machine hits `done`
   * or `error`. Never throws on a model/MCP failure — those land in the
   * machine via `fatal-error` and surface as a `'error'` emit event.
   */
  async start(userMessage: string): Promise<LoopState> {
    if (this.#state !== 'idle') {
      throw new Error(
        `LoopRunner.start: cannot start while in state '${this.#state}'`,
      );
    }
    this.#messages.push({
      role: 'user',
      content: [{ type: 'text', text: userMessage }],
    });
    this.#advance({ kind: 'user-message' });

    const maxTurns = this.#opts.maxTurns ?? DEFAULT_MAX_TURNS;
    let turn = 0;

    while (!isTerminal(this.#state) && turn < maxTurns) {
      turn += 1;

      // === awaiting-llm ===
      const req: GenerateRequest = {
        system: this.#opts.system,
        messages: this.#messages,
        tools: this.#opts.tools,
      };
      const llmRes = await this.#opts.llm.generate(req);
      if (!llmRes.ok) {
        this.#opts.emit({
          type: 'error',
          message: `llm: ${llmRes.error.message}`,
          cause: llmRes.error,
        });
        this.#advance({ kind: 'fatal-error' });
        break;
      }
      const result = llmRes.value;
      this.#appendAssistant(result);
      this.#emitTextDeltas(result.content);

      const stop = mapStop(result.stopReason);
      this.#advance({ kind: 'llm-response', stop });

      if ((this.#state as LoopState) === 'narrating') {
        const narration = collectText(result.content);
        this.#opts.emit({ type: 'narration', text: narration });
        this.#advance({ kind: 'narration-complete' });
        this.#opts.emit({ type: 'done', reason: 'end_turn' });
        break;
      }

      // === dispatching-tool → awaiting-server ===
      const toolUse = result.content.find(isToolUseBlock);
      if (!toolUse) {
        // Model said `tool_use` but didn't emit one. Treat as fatal.
        this.#opts.emit({
          type: 'error',
          message: 'llm reported tool_use stop but emitted no tool_use block',
        });
        this.#advance({ kind: 'fatal-error' });
        break;
      }
      const plan: AttemptPlan = {
        tool: toolUse.name,
        args: toolUse.input,
        intent: extractIntent(result.content),
      };
      this.#opts.emit({ type: 'tool-call', plan });

      // Hand off to retry layer.
      const outcome = await runWithRetry({
        initial: plan,
        dispatch: this.#opts.dispatch,
        recover: this.#opts.recover,
        stuckDetector: this.#opts.stuckDetector,
        retryBudget: this.#opts.retryBudget,
      });

      this.#opts.emit({ type: 'tool-result', tool: plan.tool, outcome });

      // Feed result (or error summary) back into the conversation.
      this.#appendToolResult(toolUse, outcome);

      if (outcome.status === 'ok') {
        this.#advance({ kind: 'tool-result' });
        // loop continues — back to awaiting-llm
        continue;
      }

      // Retry layer surfaced a non-recoverable outcome.
      this.#opts.emit({
        type: 'error',
        message: `tool '${plan.tool}' failed: ${outcome.status}`,
        cause: outcome,
      });
      this.#advance({ kind: 'tool-error' });
      // The state machine routes tool-error back to awaiting-llm so the
      // model can produce a graceful narration of the failure. The next
      // iteration handles that.
    }

    if (!isTerminal(this.#state)) {
      // We blew the turn cap.
      this.#opts.emit({
        type: 'error',
        message: `loop exceeded maxTurns=${maxTurns}`,
      });
      this.#advance({ kind: 'fatal-error' });
    }

    return this.#state;
  }

  // ----- internals -----

  #advance(event: LoopEvent): void {
    this.#state = reduce(this.#state, event);
  }

  #appendAssistant(result: GenerateResult): void {
    this.#messages.push({ role: 'assistant', content: result.content });
  }

  #appendToolResult(toolUse: ToolUseBlock, outcome: RunWithRetryOutcome): void {
    if (outcome.status === 'ok') {
      this.#messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: toolUse.id,
            content: JSON.stringify(outcome.value),
          },
        ],
      });
      return;
    }
    // Surface a structured error to the model so it can self-correct or
    // narrate the failure.
    const lastFailure =
      outcome.status === 'exhausted' ||
      outcome.status === 'stuck' ||
      outcome.status === 'gave_up'
        ? outcome.lastFailure
        : null;
    this.#messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          toolUseId: toolUse.id,
          content: JSON.stringify({
            status: outcome.status,
            attempts: outcome.attempts,
            lastFailure,
          }),
          isError: true,
        },
      ],
    });
  }

  #emitTextDeltas(content: readonly ContentBlock[]): void {
    for (const block of content) {
      if (isTextBlock(block) && block.text) {
        this.#opts.emit({ type: 'text-delta', text: block.text });
      }
    }
  }
}

function mapStop(s: StopReason): LlmStop {
  // 1:1 today; kept as a function so a future provider with extra stop
  // reasons (e.g. `pause_turn`) can map deliberately rather than leaking
  // an unknown string into the state machine.
  switch (s) {
    case 'tool_use':
      return 'tool_use';
    case 'end_turn':
      return 'end_turn';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
  }
}

function collectText(content: readonly ContentBlock[]): string {
  return content
    .filter(isTextBlock)
    .map((b) => b.text)
    .join('');
}

/**
 * The model may declare its turn's intent via a leading text block of the
 * form `INTENT: <free text>`. If present, we strip it off and thread it
 * into `AttemptPlan` so the recovery prompt frames retries against the
 * intent, not the mechanic. Otherwise `null` — recovery-prompt handles
 * that case explicitly.
 */
function extractIntent(content: readonly ContentBlock[]): string | null {
  for (const b of content) {
    if (!isTextBlock(b)) continue;
    const m = /^\s*INTENT:\s*(.+?)\s*$/im.exec(b.text);
    if (m) return m[1];
  }
  return null;
}
