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
  turnDocId,
  type ConversationKey,
  type ConversationStore,
  type PersistedTurn,
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
}
