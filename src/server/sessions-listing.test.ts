/**
 * Integration: `GET /sessions` (#650).
 *
 * Brings up the real HTTP server with an `InMemoryConversationStore`
 * seeded with a couple of sessions and asserts auth + listing shape.
 */

import { describe, expect, it } from 'vitest';
import { StaticDevVerifier } from './auth.js';
import { EventHub } from './hub.js';
import { SessionRegistry } from './session-registry.js';
import { createServer } from './server.js';
import { PROTOCOL_VERSION, type ListSessionsResponse } from './wire.js';
import { InMemoryConversationStore } from '../persistence/conversation-store.js';
import type { PersistedTurn } from '../persistence/conversation-store.js';

function makeTurn(
  _uid: string,
  characterId: string,
  sessionId: string,
  displayName: string,
  turnIndex: number,
  timestamp: string,
  costUsd: number,
): PersistedTurn {
  return {
    turnIndex,
    sessionId,
    characterId,
    displayName,
    timestamp,
    userMessage: `msg-${turnIndex}`,
    llmTurns: [
      {
        intent: null,
        toolCalls: [],
        narration: `n-${turnIndex}`,
      },
    ],
    tokenUsage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    totalCostUsd: costUsd,
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
    throw new Error('not exercised in listing-only test');
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

describe('GET /sessions', () => {
  it('returns 401 without a bearer token', async () => {
    const store = new InMemoryConversationStore();
    const { port, close } = await bringUp(store);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sessions`);
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  it('returns 401 for an invalid token', async () => {
    const store = new InMemoryConversationStore();
    const { port, close } = await bringUp(store);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sessions`, {
        headers: { authorization: 'Bearer tok-nope' },
      });
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  it('returns 503 when store is not configured', async () => {
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
      const res = await fetch(`http://127.0.0.1:${port}/sessions`, {
        headers: { authorization: 'Bearer tok-good' },
      });
      expect(res.status).toBe(503);
    } finally {
      await server.close();
    }
  });

  it('returns empty list for a UID with no history', async () => {
    const store = new InMemoryConversationStore();
    const { port, close } = await bringUp(store);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sessions`, {
        headers: { authorization: 'Bearer tok-good' },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ListSessionsResponse;
      expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(body.uid).toBe('uid-1');
      expect(body.sessions).toEqual([]);
    } finally {
      await close();
    }
  });

  it('returns rolled-up sessions for the authed UID, most-recent first', async () => {
    const store = new InMemoryConversationStore();
    // uid-1 has two sessions, one across two turns.
    await store.appendTurn(
      { uid: 'uid-1', characterId: 'char-A' },
      makeTurn('uid-1', 'char-A', 'sess-old', 'Niall-1', 0, '2026-05-19T10:00:00.000Z', 0.01),
    );
    await store.appendTurn(
      { uid: 'uid-1', characterId: 'char-A' },
      makeTurn('uid-1', 'char-A', 'sess-old', 'Niall-1', 1, '2026-05-19T10:05:00.000Z', 0.02),
    );
    await store.appendTurn(
      { uid: 'uid-1', characterId: 'char-B' },
      makeTurn('uid-1', 'char-B', 'sess-new', 'goblin-bait', 0, '2026-05-21T09:14:00.000Z', 0.084),
    );
    // uid-2 must not leak.
    await store.appendTurn(
      { uid: 'uid-2', characterId: 'char-X' },
      makeTurn('uid-2', 'char-X', 'sess-other', 'Stranger', 0, '2026-05-22T00:00:00.000Z', 0.5),
    );

    const { port, close } = await bringUp(store);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sessions`, {
        headers: { authorization: 'Bearer tok-good' },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ListSessionsResponse;
      expect(body.uid).toBe('uid-1');
      expect(body.sessions.map((s) => s.sessionId)).toEqual(['sess-new', 'sess-old']);
      const old = body.sessions.find((s) => s.sessionId === 'sess-old')!;
      expect(old.turns).toBe(2);
      expect(old.totalCostUsd).toBeCloseTo(0.03, 6);
      expect(old.characterId).toBe('char-A');
      expect(old.displayName).toBe('Niall-1');
      expect(old.lastActive).toBe('2026-05-19T10:05:00.000Z');
    } finally {
      await close();
    }
  });
});
