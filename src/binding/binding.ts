/**
 * AgentBinding — the foundation type that owns "which character this agent
 * process is driving."
 *
 * **Why this exists upfront, before any agent loop code.** Every later subsystem
 * (scenario runner #582, LLM provider, identity, deploy) needs a single,
 * stable answer to three questions: which entity am I, who owns me, and what
 * channels am I allowed to act on. Bolting that on later means refactoring
 * every component that touched character context, so we lock the shape in
 * before we have any consumers.
 *
 * **Design notes:**
 *
 *   1. **Three modes, only one fully implemented today.** `agent-only` is the
 *      target state for agent-bound characters — only the MCP channel can
 *      issue actions; direct Colyseus messages are rejected server-side (#581).
 *      `player-direct` is the legacy/default for human-driven characters where
 *      the Colyseus channel is the source of truth. `hybrid` is reserved for
 *      a future "human can take over an agent character" mode and currently
 *      behaves like `agent-only` on the server. We expose all three so callers
 *      compile against the final shape.
 *
 *   2. **`ownerUid` is intentionally a string, not a discriminated union.**
 *      User-bound characters use the user's UID (Google `sub` in prod,
 *      `GEAS_DEV_UID` in local dev). Future NPC bindings will use a reserved
 *      server identity (e.g. `npc:<name>`); the prefix convention is left
 *      open here on purpose so we don't bake the namespace into the type
 *      before the NPC work (out of scope for this ticket) decides on one.
 *
 *   3. **One binding per process for now.** The harness is single-character.
 *      Multi-character is a future concern; this module deliberately exposes
 *      a `createBinding()` factory (not a registry / pool) so that constraint
 *      is enforced at the call site rather than papered over here.
 *
 *   4. **Bindings are immutable values.** Frozen at construction. If the
 *      harness needs to drive a different character it constructs a new
 *      binding and rebuilds the client wiring — no mutation in place.
 */

export const BINDING_MODES = ['agent-only', 'player-direct', 'hybrid'] as const;

export type BindingMode = (typeof BINDING_MODES)[number];

export interface AgentBinding {
  /** Server-side entity / character id this process is driving. */
  readonly entityId: string;
  /**
   * Owner of the binding. For user-bound characters this is the user UID
   * (Google `sub` in prod, dev UID locally). NPC bindings will use a
   * server-reserved identity (e.g. `npc:<name>`) once that work lands — the
   * type does not constrain the prefix.
   */
  readonly ownerUid: string;
  /** Which action channels are permitted for this character. */
  readonly bindingMode: BindingMode;
}

export interface CreateBindingInput {
  entityId: string;
  ownerUid: string;
  bindingMode: BindingMode;
}

/**
 * Construct an `AgentBinding`. Validates all three fields and freezes the
 * returned object so consumers can rely on identity-equality / cache it.
 *
 * Throws on invalid input — bindings come from startup config and a malformed
 * one is a programmer error, not a runtime condition the agent loop should
 * try to recover from.
 */
export function createBinding(input: CreateBindingInput): AgentBinding {
  if (typeof input.entityId !== 'string' || input.entityId.length === 0) {
    throw new Error('createBinding: `entityId` must be a non-empty string');
  }
  if (typeof input.ownerUid !== 'string' || input.ownerUid.length === 0) {
    throw new Error('createBinding: `ownerUid` must be a non-empty string');
  }
  if (!isBindingMode(input.bindingMode)) {
    throw new Error(
      `createBinding: \`bindingMode\` must be one of ${BINDING_MODES.join(', ')}; got "${String(
        input.bindingMode,
      )}"`,
    );
  }
  return Object.freeze({
    entityId: input.entityId,
    ownerUid: input.ownerUid,
    bindingMode: input.bindingMode,
  });
}

/** Type guard — narrow an unknown to `BindingMode`. */
export function isBindingMode(v: unknown): v is BindingMode {
  return (
    typeof v === 'string' && (BINDING_MODES as readonly string[]).includes(v)
  );
}

/**
 * True when the binding mode means the MCP channel is the (only) authoritative
 * action path. Today: `agent-only` and the reserved `hybrid` mode (which the
 * server treats defensively as `agent-only` until hybrid behavior is designed).
 *
 * Mirrors the server-side `isAgentControlled` helper in
 * `geas-server/packages/server/src/rooms/GameRoom.ts` so the harness and the
 * server agree on which characters route through MCP.
 */
export function isAgentControlled(binding: AgentBinding): boolean {
  return binding.bindingMode === 'agent-only' || binding.bindingMode === 'hybrid';
}
