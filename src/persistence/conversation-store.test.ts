import { describe, it, expect } from 'vitest';
import {
  InMemoryConversationStore,
  deserializeTurn,
  serializeTurn,
  turnDocId,
  type ConversationKey,
  type PersistedTurn,
} from './conversation-store.js';

function makeTurn(
  turnIndex: number,
  overrides: Partial<PersistedTurn> = {},
): PersistedTurn {
  return {
    turnIndex,
    sessionId: 'sess-abc',
    characterId: 'char-1',
    displayName: 'Vargen',
    timestamp: `2026-05-25T00:00:${String(turnIndex).padStart(2, '0')}.000Z`,
    userMessage: `hello ${turnIndex}`,
    llmTurns: [
      {
        intent: turnIndex % 2 === 0 ? 'scout the area' : null,
        toolCalls: [
          { tool: 'look', args: { range: 5 }, status: 'ok', attempts: 1 },
        ],
        narration: `narration for turn ${turnIndex}`,
      },
    ],
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    totalCostUsd: 0.0012,
    ...overrides,
  };
}

describe('turnDocId', () => {
  it('zero-pads so lex sort matches numeric sort', () => {
    expect(turnDocId(0)).toBe('000000000000');
    expect(turnDocId(7)).toBe('000000000007');
    expect(turnDocId(123)).toBe('000000000123');
    expect(turnDocId(0) < turnDocId(1)).toBe(true);
    expect(turnDocId(9) < turnDocId(10)).toBe(true);
    expect(turnDocId(99) < turnDocId(100)).toBe(true);
  });

  it('rejects bad input', () => {
    expect(() => turnDocId(-1)).toThrow();
    expect(() => turnDocId(1.5)).toThrow();
  });
});

describe('serializeTurn / deserializeTurn', () => {
  it('round-trips a turn losslessly', () => {
    const t = makeTurn(3);
    const raw = serializeTurn(t);
    const back = deserializeTurn(raw);
    expect(back).toEqual(t);
  });

  it('round-trips a turn with error', () => {
    const t = makeTurn(4, { error: 'tool exhausted' });
    const back = deserializeTurn(serializeTurn(t));
    expect(back).toEqual(t);
  });

  it('omits undefined error from the serialised doc', () => {
    const raw = serializeTurn(makeTurn(0));
    expect('error' in raw).toBe(false);
  });

  it('deep-clones tool args so caller mutation does not bleed in', () => {
    const args = { items: [1, 2, 3] };
    const t = makeTurn(0, {
      llmTurns: [
        {
          intent: null,
          toolCalls: [{ tool: 'x', args, status: 'ok', attempts: 1 }],
          narration: '',
        },
      ],
    });
    const raw = serializeTurn(t);
    (args.items as number[]).push(99);
    const back = deserializeTurn(raw);
    expect((back.llmTurns[0].toolCalls[0].args as any).items).toEqual([1, 2, 3]);
  });

  it('throws on missing required fields', () => {
    expect(() => deserializeTurn({} as Record<string, unknown>)).toThrow(
      /missing field/,
    );
    const t = serializeTurn(makeTurn(0));
    delete (t as any).userMessage;
    expect(() => deserializeTurn(t)).toThrow(/userMessage/);
  });

  it('tolerates missing optional fields in legacy docs', () => {
    const t = serializeTurn(makeTurn(0));
    // Strip a defaultable field
    (t.llmTurns as Array<Record<string, unknown>>)[0].narration = undefined;
    delete (t.llmTurns as Array<Record<string, unknown>>)[0].narration;
    const back = deserializeTurn(t);
    expect(back.llmTurns[0].narration).toBe('');
  });
});

describe('InMemoryConversationStore', () => {
  const keyA: ConversationKey = { uid: 'uid-A', characterId: 'char-1' };
  const keyB: ConversationKey = { uid: 'uid-B', characterId: 'char-1' };
  const keyA2: ConversationKey = { uid: 'uid-A', characterId: 'char-2' };

  it('returns [] for an unknown character', async () => {
    const s = new InMemoryConversationStore();
    expect(await s.getRecentTurns(keyA, 10)).toEqual([]);
    expect(await s.getAllTurns(keyA)).toEqual([]);
  });

  it('append + read recent N (ascending order)', async () => {
    const s = new InMemoryConversationStore();
    for (let i = 0; i < 5; i++) await s.appendTurn(keyA, makeTurn(i));
    const recent = await s.getRecentTurns(keyA, 3);
    expect(recent.map((t) => t.turnIndex)).toEqual([2, 3, 4]);
  });

  it('getRecentTurns(n) where n >= total returns all', async () => {
    const s = new InMemoryConversationStore();
    for (let i = 0; i < 3; i++) await s.appendTurn(keyA, makeTurn(i));
    expect((await s.getRecentTurns(keyA, 50)).map((t) => t.turnIndex)).toEqual([
      0, 1, 2,
    ]);
  });

  it('getRecentTurns(0) returns []', async () => {
    const s = new InMemoryConversationStore();
    await s.appendTurn(keyA, makeTurn(0));
    expect(await s.getRecentTurns(keyA, 0)).toEqual([]);
  });

  it('getAllTurns returns full history ascending', async () => {
    const s = new InMemoryConversationStore();
    // Insert out of order to confirm the store sorts.
    await s.appendTurn(keyA, makeTurn(2));
    await s.appendTurn(keyA, makeTurn(0));
    await s.appendTurn(keyA, makeTurn(1));
    const all = await s.getAllTurns(keyA);
    expect(all.map((t) => t.turnIndex)).toEqual([0, 1, 2]);
  });

  it('per-UID isolation: uid-A history never leaks to uid-B', async () => {
    const s = new InMemoryConversationStore();
    await s.appendTurn(keyA, makeTurn(0, { userMessage: 'A-message' }));
    await s.appendTurn(keyB, makeTurn(0, { userMessage: 'B-message' }));
    const a = await s.getAllTurns(keyA);
    const b = await s.getAllTurns(keyB);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].userMessage).toBe('A-message');
    expect(b[0].userMessage).toBe('B-message');
  });

  it('per-character isolation within same UID', async () => {
    const s = new InMemoryConversationStore();
    await s.appendTurn(keyA, makeTurn(0, { userMessage: 'char1' }));
    await s.appendTurn(keyA2, makeTurn(0, { userMessage: 'char2' }));
    const c1 = await s.getAllTurns(keyA);
    const c2 = await s.getAllTurns(keyA2);
    expect(c1[0].userMessage).toBe('char1');
    expect(c2[0].userMessage).toBe('char2');
  });

  it('idempotent on turnIndex collision (re-append overwrites)', async () => {
    const s = new InMemoryConversationStore();
    await s.appendTurn(keyA, makeTurn(0, { userMessage: 'first' }));
    await s.appendTurn(keyA, makeTurn(0, { userMessage: 'second' }));
    const all = await s.getAllTurns(keyA);
    expect(all).toHaveLength(1);
    expect(all[0].userMessage).toBe('second');
  });

  it('survives "process restart" — second store reads back from a serialised dump', async () => {
    // This simulates the "agent state survives `npm run dev` restart" acceptance
    // criterion at the store-contract level: append, dump as JSON, re-hydrate
    // in a fresh store, read back.
    const s1 = new InMemoryConversationStore();
    for (let i = 0; i < 5; i++) await s1.appendTurn(keyA, makeTurn(i));
    const all = await s1.getAllTurns(keyA);

    // Hand-off via a serialised dump.
    const dump = JSON.stringify(all.map(serializeTurn));

    const s2 = new InMemoryConversationStore();
    const restored = (JSON.parse(dump) as Array<Record<string, unknown>>).map(
      deserializeTurn,
    );
    for (const t of restored) await s2.appendTurn(keyA, t);

    const after = await s2.getRecentTurns(keyA, 5);
    expect(after).toEqual(all);
  });
});
