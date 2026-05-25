/**
 * Session-resume helper (#650).
 *
 * Given a `ConversationStore`, the `(uid, characterId)` key, and a
 * `sessionId`, seed a fresh `LoopRunner` with the previously-persisted
 * conversation so the next user-turn happens *with* the prior context.
 *
 * Why this lives in `loop/` and not `persistence/`: it bridges the
 * persistence layer (which knows about `PersistedTurn`) and the runner
 * (which knows about `LlmMessage`). Both modules already depend on the
 * shared seed helper in `persistence/seed.ts`; this is just the small
 * ergonomic wrapper a runner factory will call.
 *
 * Idempotency: callers should invoke this once per session at runner
 * construction. Re-invoking would duplicate the history (the runner
 * doesn't dedup messages — it would just have two copies of every turn).
 */

import type {
  ConversationKey,
  ConversationStore,
} from '../persistence/conversation-store.js';
import { turnsToMessages } from '../persistence/seed.js';
import type { LoopRunner } from './runner.js';

export interface SeedRunnerInput {
  readonly runner: LoopRunner;
  readonly store: ConversationStore;
  readonly key: ConversationKey;
  readonly sessionId: string;
}

/**
 * Load `sessionId`'s history from `store`, convert to LLM messages, and
 * seed the runner. Returns the number of messages seeded so callers can
 * log / assert.
 *
 * No-op (returns 0) when the session has no persisted turns.
 */
export async function seedRunnerFromSession(
  input: SeedRunnerInput,
): Promise<number> {
  const turns = await input.store.getSessionTurns(input.key, input.sessionId);
  if (turns.length === 0) return 0;
  const msgs = turnsToMessages(turns);
  input.runner.seedMessages(msgs);
  return msgs.length;
}
