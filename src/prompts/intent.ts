/**
 * Intent parser — extracts the per-turn "intent" the model declared under
 * the plan-then-act protocol (#659).
 *
 * **What gets parsed.** An assistant turn is a sequence of content blocks.
 * Per the protocol (`system.ts`), each `tool_use` block should be preceded
 * by a `text` block of the form `Intent: <one line>`. This parser walks the
 * blocks in order, pairs each tool_use with the *nearest preceding* intent
 * line (within the same turn, not consumed by a previous tool_use), and
 * returns the per-tool-use intent map plus a per-turn summary.
 *
 * **Three classes the in-memory turn record needs to distinguish:**
 *
 *   - Present:   model emitted `Intent: scout north for goblins` — store as
 *                a trimmed string.
 *   - Explicit absent: model emitted `Intent: none` (case-insensitive) —
 *                store as `null`, which the recovery builder treats as "no
 *                higher-level goal to surface".
 *   - Missing:   no `Intent:` line found before this tool_use — also `null`,
 *                but flagged on the turn record so callers (telemetry,
 *                stuck-detector in #586's sibling tickets) can warn that the
 *                model is drifting from the protocol.
 *
 * Malformed lines (e.g. `Intent:` with empty payload, or `intent:` lowercase
 * inside a longer paragraph) are treated as missing. The parser is
 * deliberately strict on the prefix to avoid false-positive matches against
 * narrative text that happens to contain the word "intent".
 */

import type { ContentBlock, TextBlock, ToolUseBlock } from '../llm/provider.js';
import { isTextBlock, isToolUseBlock } from '../llm/provider.js';

/** Result for one tool_use block in an assistant turn. */
export interface ParsedToolIntent {
  readonly toolUseId: string;
  readonly toolName: string;
  /**
   * The intent string the model declared for this tool_use:
   *   - non-empty string for an explicit intent
   *   - `null` for `Intent: none` (explicit absence)
   *   - `null` for no `Intent:` line at all (missing — see `missing`)
   */
  readonly intent: string | null;
  /**
   * True when no `Intent:` line preceded the tool_use. Distinguishes
   * `Intent: none` (explicit, `missing=false`) from a silent skip
   * (`missing=true`) — useful for telemetry / drift warnings.
   */
  readonly missing: boolean;
}

/** Per-turn parse output. */
export interface ParsedTurnIntents {
  /** One entry per tool_use block, in turn order. */
  readonly tools: readonly ParsedToolIntent[];
  /**
   * True if any tool_use in the turn was missing its `Intent:` line. Cheap
   * roll-up for "this turn drifted from protocol" telemetry.
   */
  readonly anyMissing: boolean;
}

/**
 * Match an `Intent:` line at the start of a text block. We anchor on the
 * line start (^), accept any whitespace after the colon, and capture the
 * remainder of that line only (stop at first newline). The match is
 * case-sensitive on `Intent` — `intent:` mid-paragraph is not a directive.
 *
 * Multiline regex flag so this also matches when the model emits a
 * preamble line ahead of the intent (e.g. `Thinking...\nIntent: foo`).
 */
const INTENT_LINE_RE = /^Intent:[ \t]*(.*)$/m;

/**
 * Parse a single text block for an intent declaration. Returns:
 *   - `{ kind: 'explicit', value }` for `Intent: scout north` → `value="scout north"`.
 *   - `{ kind: 'none' }` for `Intent: none` (any case on the payload).
 *   - `null` for no match or empty payload (missing/malformed).
 */
function parseIntentBlock(
  block: TextBlock,
): { kind: 'explicit'; value: string } | { kind: 'none' } | null {
  const m = INTENT_LINE_RE.exec(block.text);
  if (!m) return null;
  const payload = m[1]!.trim();
  if (payload.length === 0) return null;
  if (payload.toLowerCase() === 'none') return { kind: 'none' };
  return { kind: 'explicit', value: payload };
}

/**
 * Parse all per-tool-use intents from one assistant turn's content blocks.
 *
 * Pairing rule: walk blocks in order, maintain a "pending intent" slot.
 * Each text block with a valid `Intent:` line overwrites the slot
 * (last-wins — handles the unusual case of two intent lines back-to-back).
 * Each tool_use block consumes the slot (clearing it). If the slot is
 * empty when a tool_use arrives, the intent for that call is recorded as
 * missing.
 */
export function parseTurnIntents(
  content: readonly ContentBlock[],
): ParsedTurnIntents {
  const tools: ParsedToolIntent[] = [];
  let pending:
    | { kind: 'explicit'; value: string }
    | { kind: 'none' }
    | null = null;
  let anyMissing = false;

  for (const block of content) {
    if (isTextBlock(block)) {
      const parsed = parseIntentBlock(block);
      if (parsed) pending = parsed;
      continue;
    }
    if (isToolUseBlock(block)) {
      const tu = block as ToolUseBlock;
      let intent: string | null;
      let missing: boolean;
      if (pending === null) {
        intent = null;
        missing = true;
        anyMissing = true;
      } else if (pending.kind === 'none') {
        intent = null;
        missing = false;
      } else {
        intent = pending.value;
        missing = false;
      }
      tools.push({
        toolUseId: tu.id,
        toolName: tu.name,
        intent,
        missing,
      });
      pending = null;
      continue;
    }
    // tool_result blocks (echoed back in some streams) and any unknown block
    // type don't influence intent pairing.
  }

  return { tools, anyMissing };
}

/**
 * Look up the intent for a specific tool_use id. Returns `null` for both
 * "explicit absent" and "missing" — callers that need to distinguish should
 * use the full `ParsedToolIntent` from `parseTurnIntents`. Convenience for
 * the recovery-prompt builder, which only cares about the displayable
 * string.
 */
export function intentForToolUse(
  parsed: ParsedTurnIntents,
  toolUseId: string,
): string | null {
  for (const t of parsed.tools) {
    if (t.toolUseId === toolUseId) return t.intent;
  }
  return null;
}
