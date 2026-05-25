/**
 * Convert persisted history into LLM-ready messages for session resume (#650).
 *
 * The runner's conversation buffer is a `readonly LlmMessage[]` of `user` /
 * `assistant` content blocks. The store keeps a structured `PersistedTurn`
 * (user text + N LLM round-trips with tool calls + narration). On resume we
 * flatten the structured form into the message shape the runner already
 * understands — same shape `LoopRunner` builds during a live turn.
 *
 * **Lossy on purpose.** We don't replay tool_use / tool_result content blocks,
 * because:
 *
 *   1. Replaying tool calls would require us to also replay the original tool
 *      responses, but the persisted shape only carries the call shape + a
 *      status string (#665 schema, by design — full payloads would blow the
 *      doc size budget).
 *   2. The acceptance criterion for #650 is "the agent recalls a fact from
 *      earlier in the stored history" — i.e. *conversational* recall. The
 *      user-message + narration text is what carries the facts; the tool
 *      calls were the path to those facts, not the facts themselves.
 *
 * So we collapse each `PersistedTurn` into:
 *   - one `user` message containing the original `userMessage`
 *   - one `assistant` message per `PersistedLlmTurn`'s `narration` (skipping
 *     empty narrations — a pure-tool round-trip emits nothing useful here)
 *
 * Future iteration (filed as a follow-up if needed): persist a per-turn
 * `summary` field on the doc and seed that as a system-side memo, so the
 * agent gets a richer recall surface without ballooning storage.
 */

import type { LlmMessage } from '../llm/provider.js';
import type { PersistedTurn } from './conversation-store.js';

export function turnsToMessages(
  turns: readonly PersistedTurn[],
): readonly LlmMessage[] {
  const out: LlmMessage[] = [];
  for (const t of turns) {
    out.push({
      role: 'user',
      content: [{ type: 'text', text: t.userMessage }],
    });
    for (const llm of t.llmTurns) {
      if (llm.narration && llm.narration.trim().length > 0) {
        out.push({
          role: 'assistant',
          content: [{ type: 'text', text: llm.narration }],
        });
      }
    }
  }
  return out;
}
