/**
 * Integration: `GET /history` (#775).
 *
 * Brings up the real HTTP server with an `InMemoryConversationStore`
 * seeded with a deep history and asserts:
 *   - auth (401 / valid-but-unknown-character)
 *   - 503 when store is unconfigured
 *   - pagination via `before` + `limit` (ascending output, `hasMore`)
 *   - 400 on missing characterId / malformed `before` or `limit`
 *   - UID isolation (one user can't fetch another's history)
 *
 * The (#691) geas-client `useChatHistory` hook is built against the
 * exact `HistoryResponse` shape this route returns; the test asserts
 * the shape so a client refresh sees the live endpoint and the stubbed
 * mock transport interchangeably.
 */

import { describe, expect, it } from 'vitest';
import { StaticDevVerifier } from './auth.js';
import { EventHub } from './hub.js';
import { SessionRegistry } from './session-registry.js';
import { createServer } from './server.js';
import {
  PROTOCOL_VERSION,
  HISTORY_MAX_LIMIT,
  type HistoryResponse,
} from './wire.js';
import {
  InMemoryConversationStore,
  type PersistedTurn,
} from '../persistence/conversation-store.js';

function makeTurn(
  characterId: string,
  sessionId: string,
  displayName: string,
  turnIndex: number,
): PersistedTurn {
  return {
    turnIndex,
    sessionId,
    characterId,
    displayName,
    timestamp: `2026-05-25T00:${String(turnIndex).padStart(2, '0')}:00.000Z`,
    userMessage: `msg-${turnIndex}`,
    llmTurns: [
      {
        intent: turnIndex % 2 === 0 ? 'scout' : null,
        toolCalls: [
          { tool: 'look', args: { range: 5 }, status: 'ok', attempts: 1 },
        ],
        narration: `n-${turnIndex}`,
      },
    ],
    tokenUsage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    totalCostUsd: 0.001,
  };
}

async function bringUp(store: InMemoryConversationStore): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const hub = new EventHub();
  const verifier = new StaticDevVerifier([
    ['tok-good', 'uid-1'],
    ['tok-other', 'uid-2'],
  ]);
  const registry = new SessionRegistry(() => {
    throw new Error('not exercised in history-only test');
  });
  const server = createServer({
    verifier,
    hub,
    registry,
    store,
    pingIntervalMs: 0,
  });
  const port = await server.listen(0);
  return { port, close: () => server.close() };
}

describe('GET /history', () => {
  it('returns 401 without a bearer token', async () => {
    const store = new InMemoryConversationStore();
    const { port, close } = await bringUp(store);
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/history?characterId=char-A`,
      );
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  it('returns 401 for an invalid bearer token', async () => {
    const store = new InMemoryConversationStore();
    const { port, close } = await bringUp(store);
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/history?characterId=char-A`,
        { headers: { authorization: 'Bearer tok-nope' } },
      );
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  it('returns 400 when characterId is missing', async () => {
    const store = new InMemoryConversationStore();
    const { port, close } = await bringUp(store);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/history`, {
        headers: { authorization: 'Bearer tok-good' },
      });
      expect(res.status).toBe(400);
    } finally {
      await close();
    }
  });

  it('returns 400 when before is not numeric', async () => {
    const store = new InMemoryConversationStore();
    const { port, close } = await bringUp(store);
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/history?characterId=char-A&before=banana`,
        { headers: { authorization: 'Bearer tok-good' } },
      );
      expect(res.status).toBe(400);
    } finally {
      await close();
    }
  });

  it('returns 400 when limit is not positive', async () => {
    const store = new InMemoryConversationStore();
    const { port, close } = await bringUp(store);
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/history?characterId=char-A&limit=0`,
        { headers: { authorization: 'Bearer tok-good' } },
      );
      expect(res.status).toBe(400);
    } finally {
      await close();
    }
  });

  it('returns 503 when store is unconfigured (matches /sessions)', async () => {
    const hub = new EventHub();
    const verifier = new StaticDevVerifier([['tok-good', 'uid-1']]);
    const registry = new SessionRegistry(() => {
      throw new Error('unused');
    });
    const server = createServer({
      verifier,
      hub,
      registry,
      pingIntervalMs: 0,
      // no store
    });
    const port = await server.listen(0);
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/history?characterId=char-A`,
        { headers: { authorization: 'Bearer tok-good' } },
      );
      expect(res.status).toBe(503);
    } finally {
      await server.close();
    }
  });

  it('returns empty turns + hasMore=false for an unknown character', async () => {
    const store = new InMemoryConversationStore();
    const { port, close } = await bringUp(store);
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/history?characterId=ghost`,
        { headers: { authorization: 'Bearer tok-good' } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as HistoryResponse;
      expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(body.uid).toBe('uid-1');
      expect(body.characterId).toBe('ghost');
      expect(body.turns).toEqual([]);
      expect(body.hasMore).toBe(false);
    } finally {
      await close();
    }
  });

  it('paginates oldest-page-first via the `before` cursor', async () => {
    const store = new InMemoryConversationStore();
    // 50 turns @ char-A on uid-1.
    for (let i = 0; i < 50; i++) {
      await store.appendTurn(
        { uid: 'uid-1', characterId: 'char-A' },
        makeTurn('char-A', 'sess-1', 'Niall', i),
      );
    }
    const { port, close } = await bringUp(store);
    try {
      // Page 1: most recent — no `before`, default limit (20).
      const r1 = await fetch(
        `http://127.0.0.1:${port}/history?characterId=char-A`,
        { headers: { authorization: 'Bearer tok-good' } },
      );
      expect(r1.status).toBe(200);
      const p1 = (await r1.json()) as HistoryResponse;
      expect(p1.turns.map((t) => t.turnIndex)).toEqual(
        Array.from({ length: 20 }, (_, i) => 30 + i),
      );
      expect(p1.hasMore).toBe(true);

      // Page 2: before=30, limit=20 → indices 10..29.
      const r2 = await fetch(
        `http://127.0.0.1:${port}/history?characterId=char-A&before=30&limit=20`,
        { headers: { authorization: 'Bearer tok-good' } },
      );
      const p2 = (await r2.json()) as HistoryResponse;
      expect(p2.turns.map((t) => t.turnIndex)).toEqual(
        Array.from({ length: 20 }, (_, i) => 10 + i),
      );
      expect(p2.hasMore).toBe(true);

      // Page 3: before=10, limit=20 → only indices 0..9 remain (no older).
      const r3 = await fetch(
        `http://127.0.0.1:${port}/history?characterId=char-A&before=10&limit=20`,
        { headers: { authorization: 'Bearer tok-good' } },
      );
      const p3 = (await r3.json()) as HistoryResponse;
      expect(p3.turns.map((t) => t.turnIndex)).toEqual(
        Array.from({ length: 10 }, (_, i) => i),
      );
      expect(p3.hasMore).toBe(false);
    } finally {
      await close();
    }
  });

  it('caps `limit` at HISTORY_MAX_LIMIT', async () => {
    const store = new InMemoryConversationStore();
    for (let i = 0; i < HISTORY_MAX_LIMIT + 25; i++) {
      await store.appendTurn(
        { uid: 'uid-1', characterId: 'char-A' },
        makeTurn('char-A', 'sess-1', 'Niall', i),
      );
    }
    const { port, close } = await bringUp(store);
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/history?characterId=char-A&limit=9999`,
        { headers: { authorization: 'Bearer tok-good' } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as HistoryResponse;
      expect(body.turns.length).toBe(HISTORY_MAX_LIMIT);
      expect(body.hasMore).toBe(true);
    } finally {
      await close();
    }
  });

  it('does not leak another UID\'s history', async () => {
    const store = new InMemoryConversationStore();
    await store.appendTurn(
      { uid: 'uid-2', characterId: 'char-A' },
      makeTurn('char-A', 'sess-other', 'Stranger', 0),
    );
    const { port, close } = await bringUp(store);
    try {
      // uid-1 asks for char-A — uid-2's data lives at (uid-2, char-A).
      // The endpoint scopes by the bearer UID, so uid-1 sees nothing.
      const res = await fetch(
        `http://127.0.0.1:${port}/history?characterId=char-A`,
        { headers: { authorization: 'Bearer tok-good' } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as HistoryResponse;
      expect(body.uid).toBe('uid-1');
      expect(body.turns).toEqual([]);
      expect(body.hasMore).toBe(false);
    } finally {
      await close();
    }
  });

  it('round-trips the full PersistedTurn shape', async () => {
    const store = new InMemoryConversationStore();
    await store.appendTurn(
      { uid: 'uid-1', characterId: 'char-A' },
      makeTurn('char-A', 'sess-1', 'Niall', 0),
    );
    const { port, close } = await bringUp(store);
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/history?characterId=char-A&limit=5`,
        { headers: { authorization: 'Bearer tok-good' } },
      );
      const body = (await res.json()) as HistoryResponse;
      expect(body.turns.length).toBe(1);
      const t = body.turns[0]!;
      expect(t.turnIndex).toBe(0);
      expect(t.sessionId).toBe('sess-1');
      expect(t.displayName).toBe('Niall');
      expect(t.userMessage).toBe('msg-0');
      expect(t.llmTurns.length).toBe(1);
      expect(t.llmTurns[0]!.toolCalls[0]!.tool).toBe('look');
      expect(t.tokenUsage.inputTokens).toBe(10);
      expect(t.totalCostUsd).toBeCloseTo(0.001, 6);
    } finally {
      await close();
    }
  });
});
