/**
 * Conversation history persistence (#665, parent #587).
 *
 * **Why this layer exists.** The agent loop holds conversation state in
 * memory (`LoopRunner#messages`, `IdleSession` turn counters). A Cloud Run
 * instance churn, an `npm run dev` restart, or a long idle that triggers
 * `onSleep` all drop that buffer. To honour the agent product contract —
 * *the agent remembers your past sessions* — we persist each completed
 * user-turn to Firestore.
 *
 * **Scope.** Append-only writes per turn. The store is the source of truth
 * for past turns; the in-memory buffer is the source of truth for the
 * *current* turn only. On wake the session reads the last N turns to bootstrap
 * the LLM context; on sleep it has nothing to do (every completed turn was
 * already persisted at completion time).
 *
 * **Why one doc per turn (not one doc per session).** Firestore doc writes
 * are atomic and bounded (~1 MiB). A long-running character could accumulate
 * thousands of turns over weeks; a single growing doc would hit the size
 * cap and force a rewrite of all prior history on every append. Per-turn
 * docs keep each write O(1) and let `getRecentTurns(n)` read just what it
 * needs via an `orderBy('turnIndex', 'desc').limit(n)` query.
 *
 * **Why `ConversationStore` is an interface, not a class.** Two-impl pattern
 * mirroring `SoulFirestoreAdapter` in geas-server:
 *
 *   - {@link InMemoryConversationStore} — unit tests, scenario harness,
 *     local-only runs where Firestore is not configured.
 *   - {@link FirestoreConversationStore} (`./firestore-conversation-store.ts`)
 *     — prod + emulator integration tests.
 *
 * Same contract, swap at construction.
 */

/** One tool call inside an LLM turn. */
export interface PersistedToolCall {
  readonly tool: string;
  /** Arbitrary JSON-serialisable args. */
  readonly args: unknown;
  /**
   * Outcome status string from `RunWithRetryOutcome` (`'ok'` / `'exhausted'`
   * / `'stuck'` / `'gave_up'`). Stored as a plain string rather than the
   * discriminated union so the persisted shape doesn't need to track every
   * future status variant.
   */
  readonly status: string;
  /** Attempt count from the retry layer. */
  readonly attempts: number;
}

/** One LLM round-trip inside a user-turn (the model may take several). */
export interface PersistedLlmTurn {
  /** Caller-declared intent (the `INTENT:` prefix the model may emit). */
  readonly intent: string | null;
  /** Tool calls dispatched during this LLM round-trip. */
  readonly toolCalls: readonly PersistedToolCall[];
  /**
   * Narration text emitted by the model. Empty string is valid (e.g. a
   * pure-tool round-trip with no chat text).
   */
  readonly narration: string;
}

/** Token accounting for a turn. Cheap sum across `PersistedLlmTurn`s. */
export interface PersistedTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

/**
 * One persisted user-turn. The shape #650 (session listing) needs:
 *
 *   - `sessionId`, `characterId`, `displayName`, `timestamp` — listing rows.
 *   - `turnIndex` — display ordering inside a session.
 *   - `totalCostUsd` — per-session cost (caller sums across turns).
 *   - `userMessage`, `llmTurns` — turn detail view.
 *
 * `turnIndex` is the doc id (zero-padded so lexical sort = numeric sort).
 */
export interface PersistedTurn {
  readonly turnIndex: number;
  readonly sessionId: string;
  readonly characterId: string;
  readonly displayName: string;
  /** ISO-8601 UTC, completion time of the turn. */
  readonly timestamp: string;
  readonly userMessage: string;
  readonly llmTurns: readonly PersistedLlmTurn[];
  readonly tokenUsage: PersistedTokenUsage;
  readonly totalCostUsd: number;
  /** Set iff the turn ended in `error` rather than `done`. */
  readonly error?: string;
}

/** Coordinate identifying a character's conversation log. */
export interface ConversationKey {
  /** UID — `GEAS_DEV_UID` locally; OAuth `sub` in prod. */
  readonly uid: string;
  /** Stable per-character id. */
  readonly characterId: string;
}

/** Storage interface — append + read. No mutate, no delete. */
export interface ConversationStore {
  /**
   * Append a turn. Idempotent on `turnIndex` (re-appending the same index
   * overwrites; callers must allocate indices monotonically — the typical
   * caller is the runner, so this is a one-line invariant).
   */
  appendTurn(key: ConversationKey, turn: PersistedTurn): Promise<void>;

  /**
   * Most-recent N turns, ordered ascending by `turnIndex` (so the LLM
   * sees them in conversation order). Returns `[]` if the character has
   * no history.
   */
  getRecentTurns(
    key: ConversationKey,
    n: number,
  ): Promise<readonly PersistedTurn[]>;

  /**
   * Entire history, ordered ascending. Used by future memory-summarisation
   * (#650 / siblings). Callers must be aware this is unbounded — only the
   * summariser should call it.
   */
  getAllTurns(key: ConversationKey): Promise<readonly PersistedTurn[]>;
}

/** Zero-pad to 12 digits so lex sort = numeric sort up to 10^12 turns. */
export function turnDocId(turnIndex: number): string {
  if (!Number.isInteger(turnIndex) || turnIndex < 0) {
    throw new Error(`turnDocId: invalid turnIndex ${turnIndex}`);
  }
  return turnIndex.toString().padStart(12, '0');
}

/**
 * Serialise a turn to a plain JSON object suitable for Firestore. Mostly a
 * pass-through, but it (a) drops `undefined` from `error` so the persisted
 * doc shape stays predictable and (b) deep-clones `args` to detach from any
 * caller-side mutation.
 */
export function serializeTurn(turn: PersistedTurn): Record<string, unknown> {
  const out: Record<string, unknown> = {
    turnIndex: turn.turnIndex,
    sessionId: turn.sessionId,
    characterId: turn.characterId,
    displayName: turn.displayName,
    timestamp: turn.timestamp,
    userMessage: turn.userMessage,
    llmTurns: turn.llmTurns.map((t) => ({
      intent: t.intent,
      toolCalls: t.toolCalls.map((c) => ({
        tool: c.tool,
        args: JSON.parse(JSON.stringify(c.args ?? null)),
        status: c.status,
        attempts: c.attempts,
      })),
      narration: t.narration,
    })),
    tokenUsage: { ...turn.tokenUsage },
    totalCostUsd: turn.totalCostUsd,
  };
  if (turn.error !== undefined) out.error = turn.error;
  return out;
}

/**
 * Inverse of `serializeTurn`. Tolerant of missing optional fields (a doc
 * written by an earlier schema version may lack `error` — that's fine).
 * Throws on a structurally invalid doc rather than producing garbage.
 */
export function deserializeTurn(raw: Record<string, unknown>): PersistedTurn {
  const required = [
    'turnIndex',
    'sessionId',
    'characterId',
    'displayName',
    'timestamp',
    'userMessage',
    'llmTurns',
    'tokenUsage',
    'totalCostUsd',
  ];
  for (const k of required) {
    if (!(k in raw)) {
      throw new Error(`deserializeTurn: missing field '${k}'`);
    }
  }
  const llmTurnsRaw = raw.llmTurns as Array<Record<string, unknown>>;
  if (!Array.isArray(llmTurnsRaw)) {
    throw new Error("deserializeTurn: 'llmTurns' must be an array");
  }
  const usageRaw = raw.tokenUsage as Record<string, unknown>;
  const turn: PersistedTurn = {
    turnIndex: raw.turnIndex as number,
    sessionId: raw.sessionId as string,
    characterId: raw.characterId as string,
    displayName: raw.displayName as string,
    timestamp: raw.timestamp as string,
    userMessage: raw.userMessage as string,
    llmTurns: llmTurnsRaw.map((t) => ({
      intent: (t.intent ?? null) as string | null,
      toolCalls: ((t.toolCalls ?? []) as Array<Record<string, unknown>>).map(
        (c) => ({
          tool: c.tool as string,
          args: c.args,
          status: c.status as string,
          attempts: (c.attempts ?? 0) as number,
        }),
      ),
      narration: (t.narration ?? '') as string,
    })),
    tokenUsage: {
      inputTokens: (usageRaw.inputTokens ?? 0) as number,
      outputTokens: (usageRaw.outputTokens ?? 0) as number,
      cacheReadInputTokens: (usageRaw.cacheReadInputTokens ?? 0) as number,
      cacheCreationInputTokens: (usageRaw.cacheCreationInputTokens ?? 0) as number,
    },
    totalCostUsd: raw.totalCostUsd as number,
    ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
  };
  return turn;
}

/**
 * In-memory implementation. Per-UID, per-character maps. Tests + local-only
 * runs (no Firestore configured) use this. Production wires
 * `FirestoreConversationStore`.
 */
export class InMemoryConversationStore implements ConversationStore {
  // key = `${uid}::${characterId}`, value = turnIndex → serialised doc.
  #docs = new Map<string, Map<number, Record<string, unknown>>>();

  async appendTurn(key: ConversationKey, turn: PersistedTurn): Promise<void> {
    const k = `${key.uid}::${key.characterId}`;
    let bucket = this.#docs.get(k);
    if (!bucket) {
      bucket = new Map();
      this.#docs.set(k, bucket);
    }
    bucket.set(turn.turnIndex, serializeTurn(turn));
  }

  async getRecentTurns(
    key: ConversationKey,
    n: number,
  ): Promise<readonly PersistedTurn[]> {
    if (n <= 0) return [];
    const bucket = this.#docs.get(`${key.uid}::${key.characterId}`);
    if (!bucket) return [];
    const sorted = [...bucket.entries()].sort(([a], [b]) => a - b);
    const slice = sorted.slice(-n);
    return slice.map(([, raw]) => deserializeTurn(raw));
  }

  async getAllTurns(key: ConversationKey): Promise<readonly PersistedTurn[]> {
    const bucket = this.#docs.get(`${key.uid}::${key.characterId}`);
    if (!bucket) return [];
    return [...bucket.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, raw]) => deserializeTurn(raw));
  }
}
