import { describe, it, expect } from 'vitest';
import { LoopRunner, type LoopEmitEvent } from './runner.js';
import { NoopProvider } from '../llm/noop.js';
import { createStuckDetector } from '../prompts/stuck.js';
import { createRetryBudget } from '../prompts/budget.js';
import { ok, err, makeError, type Result } from '../mcp/errors.js';
import type { GeasToolResponse } from '../mcp/tools.js';
import type { AttemptPlan, RecoveryDriver } from './run-with-retry.js';
import type { LlmToolDef } from '../llm/provider.js';
import { InMemoryConversationStore } from '../persistence/conversation-store.js';

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

  describe('persistence (#732)', () => {
    it('appends one PersistedTurn per start() with user message + llmTurns', async () => {
      const llm = new NoopProvider({
        script: [
          {
            stopReason: 'tool_use',
            content: [
              { type: 'text', text: 'INTENT: scout the surroundings' },
              { type: 'tool_use', id: 't1', name: 'look', input: {} },
            ],
          },
          {
            stopReason: 'end_turn',
            content: [{ type: 'text', text: 'You see a torchlit room.' }],
          },
        ],
      });
      const store = new InMemoryConversationStore();
      const key = { uid: 'u-1', characterId: 'char-A' };
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
        persistence: {
          store,
          key,
          sessionId: 'sess-X',
          displayName: 'Niall',
          nextTurnIndex: () => 0,
        },
      });

      const final = await runner.start('Where am I?');
      expect(final).toBe('done');
      // No error emit — clean persistence.
      expect(events.some((e) => e.type === 'error')).toBe(false);

      const turns = await store.getSessionTurns(key, 'sess-X');
      expect(turns).toHaveLength(1);
      const t = turns[0];
      expect(t.turnIndex).toBe(0);
      expect(t.sessionId).toBe('sess-X');
      expect(t.characterId).toBe('char-A');
      expect(t.displayName).toBe('Niall');
      expect(t.userMessage).toBe('Where am I?');
      expect(t.llmTurns).toHaveLength(2);
      // First LLM round-trip: tool_use, intent extracted, one tool call.
      expect(t.llmTurns[0].intent).toBe('scout the surroundings');
      expect(t.llmTurns[0].toolCalls).toHaveLength(1);
      expect(t.llmTurns[0].toolCalls[0].tool).toBe('look');
      expect(t.llmTurns[0].toolCalls[0].status).toBe('ok');
      // Second LLM round-trip: narration, no tool calls.
      expect(t.llmTurns[1].toolCalls).toHaveLength(0);
      expect(t.llmTurns[1].narration).toBe('You see a torchlit room.');
      // timestamp parseable as ISO.
      expect(() => new Date(t.timestamp).toISOString()).not.toThrow();
      expect(t.error).toBeUndefined();
    });

    it('cross-restart resume: two messages persisted produce 4 messages on seed', async () => {
      // Drive two user-turns end-to-end with persistence on, then verify the
      // store contains the right shape for `--list` (turns=2) and that
      // seeding a *new* runner from the same sessionId yields a 4-message
      // (2 user + 2 assistant) buffer — the acceptance scenario.
      const store = new InMemoryConversationStore();
      const key = { uid: 'u-1', characterId: 'char-A' };
      let nextIdx = 0;

      const makeRunner = (
        scriptedNarration: string,
      ): LoopRunner => {
        const llm = new NoopProvider({
          script: [
            {
              stopReason: 'end_turn',
              content: [{ type: 'text', text: scriptedNarration }],
            },
          ],
        });
        return new LoopRunner({
          llm,
          dispatch: staticDispatcher([]),
          stuckDetector: createStuckDetector(),
          retryBudget: createRetryBudget(),
          recover: neverRecover,
          tools: TOOLS,
          emit: () => undefined,
          persistence: {
            store,
            key,
            sessionId: 'sess-resume',
            displayName: 'Niall',
            nextTurnIndex: () => nextIdx++,
          },
        });
      };

      await makeRunner('Hello, traveller.').start('Hi there.');
      await makeRunner('Indeed it was.').start('Was that fun?');

      const sessions = await store.listSessions('u-1');
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe('sess-resume');
      expect(sessions[0].turns).toBe(2);

      // Now simulate a fresh process: import the seed helper and load
      // history into a brand-new runner.
      const { seedRunnerFromSession } = await import('./resume.js');
      const fresh = new LoopRunner({
        llm: new NoopProvider(),
        dispatch: staticDispatcher([]),
        stuckDetector: createStuckDetector(),
        retryBudget: createRetryBudget(),
        recover: neverRecover,
        tools: TOOLS,
        emit: () => undefined,
      });
      const seeded = await seedRunnerFromSession({
        runner: fresh,
        store,
        key,
        sessionId: 'sess-resume',
      });
      // 2 user + 2 assistant = 4 (acceptance criterion).
      expect(seeded).toBe(4);
      expect(fresh.messages).toHaveLength(4);
    });

    it('surfaces a persistence failure via emit({error}) without affecting state', async () => {
      const failingStore = {
        appendTurn: async () => {
          throw new Error('boom');
        },
        getRecentTurns: async () => [],
        getAllTurns: async () => [],
        getSessionTurns: async () => [],
        listSessions: async () => [],
      };
      const llm = new NoopProvider({
        script: [
          {
            stopReason: 'end_turn',
            content: [{ type: 'text', text: 'hi.' }],
          },
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
        persistence: {
          store: failingStore,
          key: { uid: 'u', characterId: 'c' },
          sessionId: 's',
          displayName: 'N',
          nextTurnIndex: () => 0,
        },
      });
      const final = await runner.start('hi');
      // Turn itself succeeded; persistence error surfaces afterward.
      expect(final).toBe('done');
      const errs = events.filter((e) => e.type === 'error');
      expect(errs).toHaveLength(1);
      expect(errs[0].type === 'error' && errs[0].message).toMatch(
        /persistence: boom/,
      );
    });

    it('records terminal error on the persisted turn when llm fails', async () => {
      const llm = new NoopProvider({
        script: [{ error: { kind: 'transport', message: 'dropped' } }],
      });
      const store = new InMemoryConversationStore();
      const key = { uid: 'u', characterId: 'c' };
      const runner = new LoopRunner({
        llm,
        dispatch: staticDispatcher([]),
        stuckDetector: createStuckDetector(),
        retryBudget: createRetryBudget(),
        recover: neverRecover,
        tools: TOOLS,
        emit: () => undefined,
        persistence: {
          store,
          key,
          sessionId: 's-err',
          displayName: 'N',
          nextTurnIndex: () => 0,
        },
      });
      await runner.start('hi');
      const turns = await store.getSessionTurns(key, 's-err');
      expect(turns).toHaveLength(1);
      expect(turns[0].error).toMatch(/dropped/);
    });
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
