import { describe, it, expect } from 'vitest';
import { LoopRunner, type LoopEmitEvent } from './runner.js';
import { NoopProvider } from '../llm/noop.js';
import { createStuckDetector } from '../prompts/stuck.js';
import { createRetryBudget } from '../prompts/budget.js';
import { ok, err, makeError, type Result } from '../mcp/errors.js';
import type { GeasToolResponse } from '../mcp/tools.js';
import type { AttemptPlan, RecoveryDriver } from './run-with-retry.js';
import type { LlmToolDef } from '../llm/provider.js';

const TOOLS: readonly LlmToolDef[] = [
  {
    name: 'look',
    description: 'Look around',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function captureEmitter(): {
  events: LoopEmitEvent[];
  emit: (e: LoopEmitEvent) => void;
} {
  const events: LoopEmitEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}

function staticDispatcher(
  responses: ReadonlyArray<Result<GeasToolResponse>>,
): (plan: AttemptPlan) => Promise<Result<GeasToolResponse>> {
  let i = 0;
  return async () => {
    if (i >= responses.length) {
      return err(makeError('unknown_tool', 'dispatcher exhausted'));
    }
    return responses[i++];
  };
}

const neverRecover: RecoveryDriver = async () => null;

describe('LoopRunner — end-to-end', () => {
  it('drives a full user-turn → tool → narration → done with stubs', async () => {
    const llm = new NoopProvider({
      script: [
        // turn 1: model chooses a tool
        {
          stopReason: 'tool_use',
          content: [
            { type: 'text', text: 'INTENT: scout the surroundings' },
            { type: 'tool_use', id: 't1', name: 'look', input: {} },
          ],
        },
        // turn 2: model narrates the result
        {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: 'You see a torchlit room.' }],
        },
      ],
    });

    const { events, emit } = captureEmitter();
    const runner = new LoopRunner({
      llm,
      dispatch: staticDispatcher([
        ok({
          content: [{ type: 'text', text: '{"room":"hall"}' }],
          structuredContent: { room: 'hall' },
        }),
      ]),
      stuckDetector: createStuckDetector(),
      retryBudget: createRetryBudget(),
      recover: neverRecover,
      tools: TOOLS,
      emit,
    });

    const final = await runner.start('Where am I?');

    expect(final).toBe('done');
    expect(events.map((e) => e.type)).toEqual([
      'text-delta', // "INTENT: scout..."
      'tool-call',
      'tool-result',
      'text-delta', // narration text
      'narration',
      'done',
    ]);

    // tool-call carries the parsed plan with intent extracted
    const toolCall = events.find((e) => e.type === 'tool-call');
    expect(toolCall).toBeDefined();
    if (toolCall && toolCall.type === 'tool-call') {
      expect(toolCall.plan.tool).toBe('look');
      expect(toolCall.plan.intent).toBe('scout the surroundings');
    }

    // tool-result carries an ok outcome
    const toolResult = events.find((e) => e.type === 'tool-result');
    expect(toolResult && toolResult.type === 'tool-result').toBe(true);
    if (toolResult && toolResult.type === 'tool-result') {
      expect(toolResult.outcome.status).toBe('ok');
    }

    // narration text matches what the model produced
    const nar = events.find((e) => e.type === 'narration');
    if (nar && nar.type === 'narration') {
      expect(nar.text).toBe('You see a torchlit room.');
    }

    // conversation buffer holds: user msg, assistant turn 1, tool_result, assistant turn 2
    expect(runner.messages.length).toBe(4);
    expect(runner.messages[0].role).toBe('user');
    expect(runner.messages[1].role).toBe('assistant');
    expect(runner.messages[2].role).toBe('user'); // tool_result wrapped as user
    expect(runner.messages[3].role).toBe('assistant');
  });

  it('surfaces an llm error as a fatal-error transition', async () => {
    const llm = new NoopProvider({
      script: [
        { error: { kind: 'transport', message: 'connection dropped' } },
      ],
    });
    const { events, emit } = captureEmitter();
    const runner = new LoopRunner({
      llm,
      dispatch: staticDispatcher([]),
      stuckDetector: createStuckDetector(),
      retryBudget: createRetryBudget(),
      recover: neverRecover,
      tools: TOOLS,
      emit,
    });

    const final = await runner.start('hello');
    expect(final).toBe('error');
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('surfaces a tool failure (no recovery) as a tool-result error then continues', async () => {
    const llm = new NoopProvider({
      script: [
        // turn 1: tool_use
        {
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: 't1', name: 'look', input: {} }],
        },
        // turn 2: model narrates the failure
        {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: 'I could not look around.' }],
        },
      ],
    });
    const { events, emit } = captureEmitter();
    const runner = new LoopRunner({
      llm,
      dispatch: staticDispatcher([
        err(makeError('tool_error', 'server said no')),
      ]),
      stuckDetector: createStuckDetector(),
      retryBudget: createRetryBudget({ budget: 2 }),
      recover: neverRecover, // give up immediately
      tools: TOOLS,
      emit,
    });

    const final = await runner.start('look');
    expect(final).toBe('done');
    const toolResult = events.find((e) => e.type === 'tool-result');
    if (toolResult && toolResult.type === 'tool-result') {
      expect(toolResult.outcome.status).toBe('gave_up');
    }
    // An error event surfaced
    expect(events.some((e) => e.type === 'error')).toBe(true);
    // But the loop continued and produced a narration + done
    expect(events.some((e) => e.type === 'narration')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('refuses concurrent start()', async () => {
    const llm = new NoopProvider();
    const runner = new LoopRunner({
      llm,
      dispatch: staticDispatcher([]),
      stuckDetector: createStuckDetector(),
      retryBudget: createRetryBudget(),
      recover: neverRecover,
      tools: TOOLS,
      emit: () => {},
    });
    // Burn through the noop's default fallback turn (end_turn) → done.
    const p1 = runner.start('hi');
    // While in flight, state is not idle, so a second start() throws.
    await expect(runner.start('hi again')).rejects.toThrow(/cannot start/);
    await p1;
  });

  it('caps runaway loops via maxTurns', async () => {
    // Script: always emits tool_use, never narrates. Dispatcher always
    // succeeds — so the model keeps making tool calls forever. The
    // maxTurns guard must terminate.
    const llm = new NoopProvider({
      script: Array.from({ length: 100 }, () => ({
        stopReason: 'tool_use' as const,
        content: [
          {
            type: 'tool_use' as const,
            id: 't',
            name: 'look',
            input: {},
          },
        ],
      })),
    });
    const dispatch = async (): Promise<Result<GeasToolResponse>> =>
      ok({ content: [{ type: 'text', text: '{}' }] });

    const { events, emit } = captureEmitter();
    const runner = new LoopRunner({
      llm,
      dispatch,
      stuckDetector: createStuckDetector(),
      retryBudget: createRetryBudget({ budget: 50 }),
      recover: neverRecover,
      tools: TOOLS,
      emit,
      maxTurns: 3,
    });

    const final = await runner.start('go');
    expect(final).toBe('error');
    const errEvent = events.find((e) => e.type === 'error');
    if (errEvent && errEvent.type === 'error') {
      expect(errEvent.message).toMatch(/maxTurns=3/);
    }
  });
});
