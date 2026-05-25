/**
 * System-prompt scaffolding for the plan-then-act loop (#659, parent #586).
 *
 * **The plan-then-act convention.** Each assistant turn must emit a short
 * one-line "intent" *immediately before* the tool_use block it leads to. The
 * intent is the model's own description of what it's trying to accomplish at
 * a higher level than the tool call itself — e.g. tool=`act` with
 * `kind:'move'` toward (520,400) carries intent "scout for goblins north of
 * spawn". When that tool call fails (validator reject, MCP tool_error,
 * partial outcome) the recovery prompt surfaces the intent verbatim so the
 * model retries with a different *means* toward the *same end*, rather than
 * thrashing on the failed mechanic.
 *
 * **Why text-block convention and not a tool-input field.** Three options
 * were on the table:
 *
 *   1. A leading text block on the assistant turn formatted
 *      `Intent: <one line>`, immediately before each tool_use.
 *   2. A reserved `intent` argument on every MCP tool's input schema.
 *   3. A separate `<intent>` XML/structured channel.
 *
 * (2) breaks the schema validator (#658) — every tool would need a permissive
 * `intent` field, drifting from the canonical MCP schemas geas-server exposes
 * (an explicit goal of #658 was *not* to fork schemas). (3) requires a
 * structured-output mode no provider in the candidate set guarantees without
 * cost. (1) is universal — every provider supports interleaved text +
 * tool_use blocks — and it costs ~10 tokens per turn. We picked (1).
 *
 * The format is `Intent: <one line under ~140 chars, in plain English>`. We
 * deliberately do NOT ask for JSON here: free-form one-liners are what the
 * model produces best and what's most useful to surface back to it on retry.
 */

/**
 * The plan-then-act block, suitable as a standalone segment within a larger
 * system prompt or as the system prompt itself in tests. Keep this string
 * stable across turns — it lives in the cached system prefix (see
 * `buildCachedRequest` in `src/llm/cache.ts`), so any churn here invalidates
 * the per-session cache.
 */
export const PLAN_THEN_ACT_INSTRUCTIONS = `# Plan-then-act protocol

Before every tool call, emit a single text block of the form:

  Intent: <one-line description of what you are trying to accomplish>

The intent is your higher-level goal, not a restatement of the tool call.
Good: "Intent: scout north of spawn for goblins"
Bad:  "Intent: call act with kind=move to (520, 400)"

Then, in the same assistant turn, emit the tool_use block.

If a tool call fails, your next turn will be given the failed tool, the
reason, and the intent you previously declared. Use a different tool or a
different argument shape to make progress toward the same intent — do not
simply repeat the failed call.

If you genuinely have no higher-level intent for a turn (e.g. a pure
information probe with no plan attached), emit "Intent: none" so the parser
records an explicit absence rather than a silent skip.
`.trim();

/**
 * Compose a session system prompt from a (caller-provided) persona /
 * build-guidance preamble and the plan-then-act protocol block. The protocol
 * block is appended at the end so personas remain composable — the agent
 * loop just hands its persona to this helper and never has to remember to
 * splice the protocol in.
 *
 * Both arguments are trimmed; a blank persona yields just the protocol.
 */
export function composeSystemPrompt(persona: string): string {
  const trimmed = persona.trim();
  if (trimmed.length === 0) return PLAN_THEN_ACT_INSTRUCTIONS;
  return `${trimmed}\n\n${PLAN_THEN_ACT_INSTRUCTIONS}`;
}
