/**
 * Conversation history persistence (#665).
 *
 * Public surface for the persistence module. Callers consume the store
 * interface; the runner / session wiring picks one implementation at
 * construction.
 */

export {
  InMemoryConversationStore,
  deserializeTurn,
  serializeTurn,
  summariseSessions,
  turnDocId,
} from './conversation-store.js';
export type {
  ConversationKey,
  ConversationStore,
  PersistedLlmTurn,
  PersistedToolCall,
  PersistedTokenUsage,
  PersistedTurn,
  SessionSummary,
} from './conversation-store.js';

export { FirestoreConversationStore } from './firestore-conversation-store.js';
export { initFirestore, getDb } from './firestore.js';
