/**
 * Integration: session resume threads prior history into a new LoopRunner
 * such that the next user turn is answered *with* the prior context (#650).
 *
 * The "agent recalls a fact from earlier in the stored history" acceptance
 * criterion is exercised here by:
 *
 *   1. Append a turn to a store: user said "My favourite torch is the
 *      Blue Lantern", agent narrated acknowledgement.
 *   2. Mint a fresh runner backed by a `NoopProvider` whose script's
 *      *response text* derives from inspecting the inbound messages —
 *      i.e. the model can only emit the fact if the seeding worked.
 *   3. `seedRunnerFromSession()` to load history.
 *   4. `runner.start('what was my favourite torch?')` and assert the
 *      narration emitted contains "Blue Lantern".
 */

import { describe, it, expect } from 'vitest';
import { InMemoryConversationStore } from '../persistence/conversation-store.js';
import type { PersistedTurn } from '../persistence/conversation-store.js';
import { LoopRunner } from './runner.js';
import { createStuckDetector } from '../prompts/stuck.js';
import { createRetryBudget } from '../prompts/budget.js';
import { seedRunnerFromSession } from './resume.js';
import {
  llmOk,
  type LlmProvider,
  type GenerateRequest,
  type GenerateResult,
  type LlmMessage,
  type LlmResult,
  type StreamEvent,
} from '../llm/provider.js';
import type { AttemptPlan, RecoveryDriver } from './run-with-retry.js';

const neverRecover: RecoveryDriver = async () => null;

function unusedDispatch() {
  return async (_plan: AttemptPlan) => {
    throw new Error('dispatcher unused — no tool calls expected');
  };
}

function makeTurn(opts: {
  turnIndex: number;
  sessionId: string;
  userMessage: string;
  narration: string;
}): PersistedTurn {
  return {
    turnIndex: opts.turnIndex,
    sessionId: opts.sessionId,
    characterId: 'char-1',
    displayName: 'Vargen',
    timestamp: `2026-05-25T00:00:${String(opts.turnIndex).padStart(2, '0')}.000Z`,
    userMessage: opts.userMessage,
    llmTurns: [
      {
        intent: null,
        toolCalls: [],
        narration: opts.narration,
      },
    ],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    totalCostUsd: 0,
  };
}

/**
 * Test-only LLM provider that inspects the inbound message history for
 * the fact and echoes it back. Verifies seeding without relying on a real
 * model.
 */
class RecallingProvider implements LlmProvider {
  readonly name = 'recalling-provider';
  async generate(req: GenerateRequest): Promise<LlmResult<GenerateResult>> {
    const haystack = collectAllText(req.messages);
    const fact = /Blue Lantern/i.test(haystack)
      ? 'You told me earlier: your favourite torch is the Blue Lantern.'
      : 'I have no memory of any torch.';
    return llmOk({
      stopReason: 'end_turn',
      content: [{ type: 'text', text: fact }],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    });
  }
  // eslint-disable-next-line require-yield
  async *streamGenerate(_req: GenerateRequest): AsyncIterable<StreamEvent> {
    throw new Error('streamGenerate not used in this test');
  }
}

function collectAllText(msgs: readonly LlmMessage[]): string {
  const out: string[] = [];
  for (const m of msgs) {
    for (const c of m.content) {
      if (c.type === 'text') out.push(c.text);
    }
  }
  return out.join('\n');
}

describe('seedRunnerFromSession (session resume)', () => {
  it('returns 0 when the session has no history', async () => {
    const store = new InMemoryConversationStore();
    const runner = new LoopRunner({
      llm: new RecallingProvider(),
      dispatch: unusedDispatch(),
      stuckDetector: createStuckDetector(),
      retryBudget: createRetryBudget(),
      recover: neverRecover,
      tools: [],
      emit: () => undefined,
    });
    const n = await seedRunnerFromSession({
      runner,
      store,
      key: { uid: 'u', characterId: 'char-1' },
      sessionId: 'sess-unknown',
    });
    expect(n).toBe(0);
    expect(runner.messages).toHaveLength(0);
  });

  it('seeds prior history so the next turn recalls a fact', async () => {
    const store = new InMemoryConversationStore();
    const key = { uid: 'u', characterId: 'char-1' };
    await store.appendTurn(
      key,
      makeTurn({
        turnIndex: 0,
        sessionId: 'sess-A',
        userMessage: 'My favourite torch is the Blue Lantern.',
        narration: "Noted — I'll remember the Blue Lantern.",
      }),
    );

    const emitted: string[] = [];
    const runner = new LoopRunner({
      llm: new RecallingProvider(),
      dispatch: unusedDispatch(),
      stuckDetector: createStuckDetector(),
      retryBudget: createRetryBudget(),
      recover: neverRecover,
      tools: [],
      emit: (ev) => {
        if (ev.type === 'narration') emitted.push(ev.text);
      },
    });

    const seeded = await seedRunnerFromSession({
      runner,
      store,
      key,
      sessionId: 'sess-A',
    });
    // 1 user + 1 assistant = 2 messages.
    expect(seeded).toBe(2);
    expect(runner.messages).toHaveLength(2);

    await runner.start('what was my favourite torch?');

    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.join('\n')).toMatch(/Blue Lantern/);
  });

  it('only seeds the named session — not bleeds from a sibling session', async () => {
    const store = new InMemoryConversationStore();
    const key = { uid: 'u', characterId: 'char-1' };
    await store.appendTurn(
      key,
      makeTurn({
        turnIndex: 0,
        sessionId: 'sess-other',
        userMessage: 'My favourite torch is the Blue Lantern.',
        narration: 'Noted.',
      }),
    );
    const runner = new LoopRunner({
      llm: new RecallingProvider(),
      dispatch: unusedDispatch(),
      stuckDetector: createStuckDetector(),
      retryBudget: createRetryBudget(),
      recover: neverRecover,
      tools: [],
      emit: () => undefined,
    });
    const seeded = await seedRunnerFromSession({
      runner,
      store,
      key,
      sessionId: 'sess-A', // different session
    });
    expect(seeded).toBe(0);
    expect(runner.messages).toHaveLength(0);
  });

  it('LoopRunner.seedMessages throws if called after start', async () => {
    const store = new InMemoryConversationStore();
    const runner = new LoopRunner({
      llm: new RecallingProvider(),
      dispatch: unusedDispatch(),
      stuckDetector: createStuckDetector(),
      retryBudget: createRetryBudget(),
      recover: neverRecover,
      tools: [],
      emit: () => undefined,
    });
    await runner.start('hi');
    expect(() =>
      runner.seedMessages([
        { role: 'user', content: [{ type: 'text', text: 'late' }] },
      ]),
    ).toThrow(/seed before start/);
    void store;
  });
});
