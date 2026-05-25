/**
 * Live Firestore integration test for `FirestoreConversationStore` (#665).
 *
 * **Opt-in.** Runs only if `FIRESTORE_EMULATOR_HOST` is set. The emulator
 * comes up automatically as part of the geas-server stack
 * (`packages/server` boots it on :8085 via `.firestore-data/`); operators
 * who want this test to run set:
 *
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 npm run test:integration
 *
 * Without the env var the suite is skipped — keeps `test:integration` green
 * in environments without an emulator.
 *
 * **What this test covers.** The two issue acceptance criteria the unit
 * tests can't reach:
 *
 *   1. *Agent state survives `npm run dev` restart.* Simulated by writing 5
 *      turns, dropping the store reference (the "process") and the
 *      firebase-admin app singleton, then re-instantiating and reading
 *      back. If anything was held in process memory rather than written
 *      through to Firestore, the read returns wrong data.
 *   2. *Per-UID isolation.* Two UIDs writing to the same characterId never
 *      see each other's turns.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import { deleteApp, getApps } from 'firebase-admin/app';
import {
  initFirestore,
  __resetFirestoreForTests,
} from '../../src/persistence/firestore.js';
import { FirestoreConversationStore } from '../../src/persistence/firestore-conversation-store.js';
import type {
  ConversationKey,
  PersistedTurn,
} from '../../src/persistence/conversation-store.js';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const describeLive = EMULATOR ? describe : describe.skip;

if (!EMULATOR) {
  // One-line note in the test output so it's obvious why this file ran no
  // assertions — helps debugging when CI looks suspiciously fast.
  // eslint-disable-next-line no-console
  console.log(
    '[firestore-conversation-store.live] skipped — FIRESTORE_EMULATOR_HOST not set',
  );
}

// Unique test run id so concurrent test runs (or stale data from a previous
// run that didn't clean up) don't collide.
const RUN = `t${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

function makeTurn(
  turnIndex: number,
  overrides: Partial<PersistedTurn> = {},
): PersistedTurn {
  return {
    turnIndex,
    sessionId: `sess-${RUN}`,
    characterId: 'char-1',
    displayName: 'Vargen',
    timestamp: new Date(2026, 4, 25, 0, 0, turnIndex).toISOString(),
    userMessage: `hello ${turnIndex}`,
    llmTurns: [
      {
        intent: null,
        toolCalls: [
          { tool: 'look', args: { range: 5 }, status: 'ok', attempts: 1 },
        ],
        narration: `narration ${turnIndex}`,
      },
    ],
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    totalCostUsd: 0.001,
    ...overrides,
  };
}

describeLive('FirestoreConversationStore (live emulator)', () => {
  beforeAll(() => {
    process.env.FIREBASE_PROJECT_ID =
      process.env.FIREBASE_PROJECT_ID ?? 'geas-rpg-test';
  });

  afterEach(async () => {
    // Best-effort cleanup — fully resetting the app between tests lets
    // "process restart" scenarios actually re-init.
    __resetFirestoreForTests();
    for (const a of getApps()) await deleteApp(a);
  });

  afterAll(async () => {
    __resetFirestoreForTests();
    for (const a of getApps()) await deleteApp(a);
  });

  it('writes 5 turns and reads them back', async () => {
    const db = initFirestore();
    const store = new FirestoreConversationStore(db);
    const key: ConversationKey = {
      uid: `uid-${RUN}-A`,
      characterId: 'char-1',
    };

    for (let i = 0; i < 5; i++) {
      await store.appendTurn(key, makeTurn(i));
    }

    const recent = await store.getRecentTurns(key, 3);
    expect(recent.map((t) => t.turnIndex)).toEqual([2, 3, 4]);

    const all = await store.getAllTurns(key);
    expect(all.map((t) => t.turnIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(all[2].userMessage).toBe('hello 2');
    expect(all[4].llmTurns[0].toolCalls[0].tool).toBe('look');
  });

  it('survives "process restart" — re-init reads prior writes', async () => {
    // First "process".
    let db = initFirestore();
    let store = new FirestoreConversationStore(db);
    const key: ConversationKey = {
      uid: `uid-${RUN}-restart`,
      characterId: 'char-1',
    };
    for (let i = 0; i < 5; i++) await store.appendTurn(key, makeTurn(i));

    // "Restart" — drop the firebase-admin app + module singleton.
    __resetFirestoreForTests();
    for (const a of getApps()) await deleteApp(a);

    // Second "process" — fresh init, same env.
    db = initFirestore();
    store = new FirestoreConversationStore(db);

    const recent = await store.getRecentTurns(key, 5);
    expect(recent).toHaveLength(5);
    expect(recent.map((t) => t.turnIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(recent[0].userMessage).toBe('hello 0');
    expect(recent[4].userMessage).toBe('hello 4');
  });

  it('per-UID isolation — uid-A history never leaks to uid-B', async () => {
    const db = initFirestore();
    const store = new FirestoreConversationStore(db);
    const keyA: ConversationKey = {
      uid: `uid-${RUN}-iso-A`,
      characterId: 'char-1',
    };
    const keyB: ConversationKey = {
      uid: `uid-${RUN}-iso-B`,
      characterId: 'char-1',
    };

    await store.appendTurn(
      keyA,
      makeTurn(0, { userMessage: 'A secrets' }),
    );
    await store.appendTurn(
      keyB,
      makeTurn(0, { userMessage: 'B secrets' }),
    );

    const a = await store.getAllTurns(keyA);
    const b = await store.getAllTurns(keyB);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].userMessage).toBe('A secrets');
    expect(b[0].userMessage).toBe('B secrets');
  });

  it('returns [] for an unknown character', async () => {
    const db = initFirestore();
    const store = new FirestoreConversationStore(db);
    const key: ConversationKey = {
      uid: `uid-${RUN}-empty`,
      characterId: 'char-1',
    };
    expect(await store.getAllTurns(key)).toEqual([]);
    expect(await store.getRecentTurns(key, 10)).toEqual([]);
  });

  it('zero-padded doc ids — recent ordering survives crossing 10 / 100 boundaries', async () => {
    const db = initFirestore();
    const store = new FirestoreConversationStore(db);
    const key: ConversationKey = {
      uid: `uid-${RUN}-bound`,
      characterId: 'char-1',
    };
    // Write turns 8..12 in non-sequential order to make sure the read-back
    // ordering comes from the doc id, not insertion order.
    const indices = [12, 9, 11, 8, 10];
    for (const i of indices) await store.appendTurn(key, makeTurn(i));
    const all = await store.getAllTurns(key);
    expect(all.map((t) => t.turnIndex)).toEqual([8, 9, 10, 11, 12]);
    const recent3 = await store.getRecentTurns(key, 3);
    expect(recent3.map((t) => t.turnIndex)).toEqual([10, 11, 12]);
  });
});
