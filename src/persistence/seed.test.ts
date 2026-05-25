import { describe, it, expect } from 'vitest';
import type { PersistedTurn } from './conversation-store.js';
import { turnsToMessages } from './seed.js';

function makeTurn(
  turnIndex: number,
  userMessage: string,
  narrations: readonly string[],
): PersistedTurn {
  return {
    turnIndex,
    sessionId: 'sess-1',
    characterId: 'char-1',
    displayName: 'Vargen',
    timestamp: `2026-05-25T00:00:${String(turnIndex).padStart(2, '0')}.000Z`,
    userMessage,
    llmTurns: narrations.map((n) => ({
      intent: null,
      toolCalls: [],
      narration: n,
    })),
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    totalCostUsd: 0,
  };
}

describe('turnsToMessages', () => {
  it('returns [] for no turns', () => {
    expect(turnsToMessages([])).toEqual([]);
  });

  it('emits user + assistant messages per turn', () => {
    const msgs = turnsToMessages([
      makeTurn(0, 'what is my name?', ['You are Vargen, a level 3 mage.']),
    ]);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'what is my name?' }],
    });
    expect(msgs[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'You are Vargen, a level 3 mage.' }],
    });
  });

  it('skips empty narrations (pure-tool round-trips)', () => {
    const msgs = turnsToMessages([makeTurn(0, 'look around', ['', '   ', 'I see a goblin.'])]);
    // user + one assistant (only the non-empty narration)
    expect(msgs).toHaveLength(2);
    expect(msgs[1].role).toBe('assistant');
    expect((msgs[1].content[0] as { text: string }).text).toBe('I see a goblin.');
  });

  it('preserves turn order across multiple turns', () => {
    const msgs = turnsToMessages([
      makeTurn(0, 'first', ['narration-1']),
      makeTurn(1, 'second', ['narration-2']),
    ]);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect((msgs[0].content[0] as { text: string }).text).toBe('first');
    expect((msgs[2].content[0] as { text: string }).text).toBe('second');
  });
});
