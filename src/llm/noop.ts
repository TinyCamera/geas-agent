/**
 * NoopProvider — the test double for {@link LlmProvider}.
 *
 * No network, no SDK. Drives the agent loop in unit/integration tests by
 * replaying a scripted sequence of model turns (including tool calls and
 * synthetic provider errors). It also records every {@link GenerateRequest}
 * it was handed so tests can assert the harness built the prompt / tool
 * defs / cache markers correctly.
 *
 * This is the only concrete provider this slice ships — real vendor adapters
 * (Anthropic first, per geas-server #585) are separate sub-issues of #584.
 */

import {
  type ContentBlock,
  type GenerateRequest,
  type GenerateResult,
  type LlmError,
  type LlmProvider,
  type LlmResult,
  type StopReason,
  type StreamEvent,
  type TextBlock,
  isTextBlock,
  llmErr,
  llmOk,
  makeLlmError,
  ZERO_USAGE,
} from './provider.js';

/**
 * One scripted model turn. Supply either a successful turn (`content` +
 * `stopReason`) or a synthetic provider `error`. The provider replays these
 * in order; once exhausted it falls back to a benign `end_turn` text turn so
 * a loop that over-iterates degrades predictably instead of hanging.
 */
export type ScriptedTurn =
  | {
      readonly stopReason?: StopReason;
      readonly content: readonly ContentBlock[];
      readonly model?: string;
      readonly error?: undefined;
    }
  | {
      readonly error: Pick<LlmError, 'kind' | 'message'> &
        Partial<Pick<LlmError, 'cause' | 'retryable'>>;
    };

export interface NoopProviderOptions {
  /** Turns to replay, in order. Defaults to empty (always the fallback turn). */
  readonly script?: readonly ScriptedTurn[];
  /** Override the provider name surfaced in telemetry. */
  readonly name?: string;
}

const DEFAULT_TURN: { stopReason: StopReason; content: readonly ContentBlock[] } = {
  stopReason: 'end_turn',
  content: [{ type: 'text', text: '(noop) no scripted turn — ending.' }],
};

export class NoopProvider implements LlmProvider {
  readonly name: string;

  /** Every request passed to `generate` / `streamGenerate`, in order. */
  readonly requests: GenerateRequest[] = [];

  #script: readonly ScriptedTurn[];
  #cursor = 0;

  constructor(opts: NoopProviderOptions = {}) {
    this.name = opts.name ?? 'noop';
    this.#script = opts.script ?? [];
  }

  /** Number of scripted turns not yet consumed. Test convenience. */
  get remainingTurns(): number {
    return Math.max(0, this.#script.length - this.#cursor);
  }

  #nextTurn(): ScriptedTurn | undefined {
    if (this.#cursor >= this.#script.length) return undefined;
    return this.#script[this.#cursor++];
  }

  #resolve(req: GenerateRequest): LlmResult<GenerateResult> {
    this.requests.push(req);
    const turn = this.#nextTurn();

    if (turn && 'error' in turn && turn.error) {
      const e = turn.error;
      return llmErr(
        makeLlmError(e.kind, e.message, {
          cause: e.cause,
          retryable: e.retryable,
        }),
      );
    }

    if (turn && 'content' in turn) {
      return llmOk({
        stopReason: turn.stopReason ?? 'end_turn',
        content: turn.content,
        usage: ZERO_USAGE,
        model: turn.model,
      });
    }

    // Exhausted / empty script — predictable benign fallback.
    return llmOk({
      stopReason: DEFAULT_TURN.stopReason,
      content: DEFAULT_TURN.content,
      usage: ZERO_USAGE,
    });
  }

  async generate(req: GenerateRequest): Promise<LlmResult<GenerateResult>> {
    return this.#resolve(req);
  }

  async *streamGenerate(req: GenerateRequest): AsyncIterable<StreamEvent> {
    const res = this.#resolve(req);

    if (!res.ok) {
      yield { type: 'error', error: res.error };
      return;
    }

    // Stream text blocks as deltas so consumers exercise their delta path,
    // then close with the terminal result. Tool-use turns have no text and
    // come through as a single `result` event.
    for (const block of res.value.content) {
      if (isTextBlock(block)) {
        yield { type: 'text_delta', text: (block as TextBlock).text };
      }
    }
    yield { type: 'result', result: res.value };
  }
}
