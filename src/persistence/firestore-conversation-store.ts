/**
 * Firestore-backed `ConversationStore` (#665).
 *
 * Collection layout (matches the issue):
 *
 * ```
 * agent_conversations/{uid}/characters/{characterId}/turns/{turnDocId}
 * ```
 *
 * `turnDocId` is `turnIndex` zero-padded so ascending document-id sort =
 * ascending numeric sort. Reads use `orderBy('turnIndex', ...)` rather than
 * `orderBy('__name__', ...)` because the emulator rejects descending key
 * scans (`FAILED_PRECONDITION: Firestore does not support descending key
 * scans`). Single-field index on `turnIndex` is auto-created — no
 * `firestore.indexes.json` deploy needed.
 */

import type { Firestore, DocumentData } from 'firebase-admin/firestore';
import {
  deserializeTurn,
  serializeTurn,
  summariseSessions,
  turnDocId,
  type ConversationKey,
  type ConversationStore,
  type PersistedTurn,
  type SessionSummary,
} from './conversation-store.js';

const ROOT_COLLECTION = 'agent_conversations';
const TURNS_SUBCOLLECTION = 'turns';
const CHARACTERS_SUBCOLLECTION = 'characters';

export class FirestoreConversationStore implements ConversationStore {
  #db: Firestore;

  constructor(db: Firestore) {
    this.#db = db;
  }

  #turnsCollection(key: ConversationKey) {
    return this.#db
      .collection(ROOT_COLLECTION)
      .doc(key.uid)
      .collection(CHARACTERS_SUBCOLLECTION)
      .doc(key.characterId)
      .collection(TURNS_SUBCOLLECTION);
  }

  async appendTurn(
    key: ConversationKey,
    turn: PersistedTurn,
  ): Promise<void> {
    const docId = turnDocId(turn.turnIndex);
    await this.#turnsCollection(key).doc(docId).set(serializeTurn(turn));
  }

  async getRecentTurns(
    key: ConversationKey,
    n: number,
  ): Promise<readonly PersistedTurn[]> {
    if (n <= 0) return [];
    // Read N most recent (by doc id descending) then reverse to ascending
    // so the caller can feed them into the LLM as-is.
    const snap = await this.#turnsCollection(key)
      .orderBy('turnIndex', 'desc')
      .limit(n)
      .get();
    const turns: PersistedTurn[] = [];
    snap.forEach((doc) => {
      turns.push(deserializeTurn(doc.data() as DocumentData));
    });
    return turns.reverse();
  }

  async getAllTurns(
    key: ConversationKey,
  ): Promise<readonly PersistedTurn[]> {
    const snap = await this.#turnsCollection(key)
      .orderBy('turnIndex', 'asc')
      .get();
    const turns: PersistedTurn[] = [];
    snap.forEach((doc) => {
      turns.push(deserializeTurn(doc.data() as DocumentData));
    });
    return turns;
  }

  async getSessionTurns(
    key: ConversationKey,
    sessionId: string,
  ): Promise<readonly PersistedTurn[]> {
    // Equality filter on sessionId + ascending turnIndex. The (sessionId,
    // turnIndex) composite index is auto-created on first query by the
    // emulator and a one-line addition to `firestore.indexes.json` in prod;
    // we keep the index manifest out of this commit since the deploy story
    // for geas-agent isn't wired yet.
    const snap = await this.#turnsCollection(key)
      .where('sessionId', '==', sessionId)
      .orderBy('turnIndex', 'asc')
      .get();
    const turns: PersistedTurn[] = [];
    snap.forEach((doc) => {
      turns.push(deserializeTurn(doc.data() as DocumentData));
    });
    return turns;
  }

  async getOlderTurns(
    key: ConversationKey,
    before: number,
    limit: number,
  ): Promise<readonly PersistedTurn[]> {
    if (limit <= 0) return [];
    // Push the desc + limit into Firestore (already indexed on
    // `turnIndex`) and reverse to ascending for the caller. `before` is
    // exclusive so use `<`, not `<=`.
    const snap = await this.#turnsCollection(key)
      .where('turnIndex', '<', before)
      .orderBy('turnIndex', 'desc')
      .limit(limit)
      .get();
    const turns: PersistedTurn[] = [];
    snap.forEach((doc) => {
      turns.push(deserializeTurn(doc.data() as DocumentData));
    });
    return turns.reverse();
  }

  async listSessions(uid: string): Promise<readonly SessionSummary[]> {
    // Enumerate the user's characters by listing the `characters`
    // subcollection under their doc, then pull every turn for each.
    // For a v1 dev UID this is fine; if/when a user accumulates many
    // characters with deep histories this becomes a candidate for a
    // dedicated `agent_sessions/{uid}/{sessionId}` rollup doc maintained
    // on write. Filed forward (not blocking #650 acceptance).
    const userDoc = this.#db.collection(ROOT_COLLECTION).doc(uid);
    const characterCols = await userDoc.listCollections();
    const characterColRefs = characterCols.filter(
      (c) => c.id === CHARACTERS_SUBCOLLECTION,
    );
    const allTurns: PersistedTurn[] = [];
    for (const col of characterColRefs) {
      const charDocs = await col.listDocuments();
      for (const charDoc of charDocs) {
        const snap = await charDoc.collection(TURNS_SUBCOLLECTION).get();
        snap.forEach((doc) => {
          allTurns.push(deserializeTurn(doc.data() as DocumentData));
        });
      }
    }
    return summariseSessions(allTurns);
  }
}
