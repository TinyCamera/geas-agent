/**
 * Conversation summarisation for long-running characters (#666, parent #587).
 *
 * **Why this layer exists.** A character driven across dozens of sessions
 * accumulates a turn buffer that, replayed verbatim, will blow past any
 * model's context window. The #665 store keeps every turn forever (audit
 * trail / replay), but the *active LLM context* needs to be bounded. This
 * module is the bounding mechanism: keep the last K turns full-fidelity,
 * compress everything older into a single structured summary blob, and
 * splice the summary back into the prompt as the first user-role message.
 *
 * **Why a separate LLM call, not in-band.** Per #585's spike: cost is
 * dominated by repeated *input* — the same long history is re-uploaded on
 * every turn. Caching helps within the ~5 minute prompt-cache TTL window;
 * summarisation is the long-term lever after caching expires or the
 * cumulative history exceeds reasonable per-call sizing. So we issue one
 * deliberate summarise call when the trigger fires, persist the structured
 * result, and from then on prepend the summary instead of the raw older
 * turns. The summarise call is *also* an LLM call — it shows up in
 * telemetry (#612) just like every other generate, with the same provider
 * pricing applied — so the verification harness can assert summarisation
 * cost stays within the per-active-hour budget.
 *
 * **Why the summariser takes `LlmProvider`, not a vendor SDK.** Same reason
 * the rest of the agent harness does (#609 / #584): integration tests need
 * to drive the trigger logic with a `NoopProvider` script, and the
 * verification harness needs to be able to swap Anthropic ↔ Gemini in one
 * line. Wrapping the provider with `TelemetryProvider` at the outer
 * construction site means summarise calls are automatically priced and
 * appear in `CostAggregator.summary()` — no separate accounting path.
 *
 * **Why a structured (JSON) summary, not free-form prose.** Free-form
 * collapses everything into one undifferentiated blob, which the model
 * then has to re-parse on every turn. A schema (`recentEvents`,
 * `locationContext`, `npcRelationships`, `openQuests`) preserves the
 * categorical structure that the agent actually queries — and lets the
 * harness assert per-section presence in tests without brittle prose
 * matching.
 *
 * **Replacement strategy.** `summariseIfNeeded()` returns a
 * {@link SummarisationOutcome} which is either `skipped` (under threshold)
 * or `summarised` with `{ summary, keptTurns, droppedTurnIndices }`. The
 * caller (typically a runner / session) is responsible for splicing the
 * summary into the message buffer — we do not own the buffer here. The
 * `buildSummaryMessage()` helper formats the structured summary as a
 * single LLM `user` message ready to prepend.
 *
 * **Cost knob.** The `tag` field is threaded through to the wrapping
 * TelemetryProvider via the caller (e.g. by constructing a
 * per-summarise-call telemetry tag like `summarise:char-1`), so the cost
 * harness can grep summarise records out of `log.jsonl` and report
 * "summarisation cost as a fraction of total" — the line the epic asks for.
 */

import {
  type GenerateRequest,
  type LlmMessage,
  type LlmProvider,
  type LlmResult,
  type GenerateResult,
  type ContentBlock,
  isTextBlock,
} from '../llm/provider.js';
import type { PersistedTurn } from '../persistence/conversation-store.js';

/**
 * Structured summary of older turns. Each field is human-readable text the
 * model can quote into narration; together they reconstruct the parts of
 * conversation state the agent actually queries between turns.
 */
export interface StructuredSummary {
  /**
   * What happened, chronologically. 1-2 sentences per notable beat. Reads
   * like a campaign recap rather than a transcript.
   */
  readonly recentEvents: string;
  /**
   * Where the character is, how they got there, what's around. Lets a wake
   * after a long sleep skip a re-`look` round-trip.
   */
  readonly locationContext: string;
  /**
   * Named NPCs the character has interacted with + their stance (friendly,
   * hostile, owes-favour, etc.). Important for continuity of social play.
   */
  readonly npcRelationships: string;
  /**
   * Open quests, pending decisions, and unresolved promises. The single
   * most important field for "what should I do next" reasoning.
   */
  readonly openQuests: string;
}

/**
 * The seam any concrete summariser implements. One-method interface so
 * tests can stub without ceremony.
 */
export interface ConversationSummarizer {
  /**
   * Reduce a list of older turns to one structured summary. Throws nothing
   * on a provider failure — returns a typed error result so the caller
   * can fall back to "keep raw history this turn, retry next turn".
   */
  summarize(
    turns: readonly PersistedTurn[],
  ): Promise<SummarizeResult>;
}

export type SummarizeResult =
  | { readonly ok: true; readonly summary: StructuredSummary }
  | { readonly ok: false; readonly error: string };

/**
 * Crude token estimator. Roughly `chars / 4` is the long-standing rule of
 * thumb for English text; tool args and tool results count too so we apply
 * the same heuristic to a JSON serialisation of the turn. It's a *trigger*
 * input, not a billing input — the real token count comes from the
 * provider response after the next generate. Under-estimating delays a
 * summarise that should have fired (cheap mistake); over-estimating fires
 * a summarise too early (wastes one call). Both are recoverable.
 */
export function estimateTurnTokens(turn: PersistedTurn): number {
  // Use the persisted token usage if it looks plausible — that's the
  // most accurate signal we have, since it was reported by the provider
  // when this turn was generated.
  const reported =
    turn.tokenUsage.inputTokens +
    turn.tokenUsage.outputTokens +
    turn.tokenUsage.cacheReadInputTokens;
  if (reported > 0) return reported;
  // Fallback: estimate from serialised size.
  const json = JSON.stringify({
    userMessage: turn.userMessage,
    llmTurns: turn.llmTurns,
  });
  return Math.ceil(json.length / 4);
}

/** Sum {@link estimateTurnTokens} across a list. */
export function estimateBufferTokens(
  turns: readonly PersistedTurn[],
): number {
  let total = 0;
  for (const t of turns) total += estimateTurnTokens(t);
  return total;
}

export interface SummariseThresholdInput {
  readonly turns: readonly PersistedTurn[];
  /**
   * Token budget that triggers summarisation. Default is 70% of a
   * 200k-token context window (140 000). Callers tuning for smaller
   * models pass a smaller number.
   */
  readonly thresholdTokens?: number;
  /**
   * Keep at least this many most-recent turns full-fidelity. Default 10.
   * Older turns are candidates for summarisation. If `turns.length <=
   * keepRecentTurns` we never summarise (no older turns to compress).
   */
  readonly keepRecentTurns?: number;
}

export const DEFAULT_THRESHOLD_TOKENS = 140_000;
export const DEFAULT_KEEP_RECENT_TURNS = 10;

export interface SummarisationDecision {
  /** True iff the buffer exceeds the threshold *and* has anything to drop. */
  readonly shouldSummarise: boolean;
  /** Turns that would be kept verbatim (suffix). */
  readonly keptTurns: readonly PersistedTurn[];
  /** Turns that would be summarised (prefix). */
  readonly droppedTurns: readonly PersistedTurn[];
  /** Estimated token total at decision time. */
  readonly estimatedTokens: number;
}

/**
 * Pure trigger logic. Given a turn buffer + thresholds, decide whether a
 * summarise call is warranted and which turns participate. No I/O; the
 * caller invokes the summariser only when `shouldSummarise` is true.
 */
export function decideSummarisation(
  input: SummariseThresholdInput,
): SummarisationDecision {
  const keepRecent = input.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS;
  const threshold = input.thresholdTokens ?? DEFAULT_THRESHOLD_TOKENS;
  const estimated = estimateBufferTokens(input.turns);
  const exceedsThreshold = estimated > threshold;
  const hasDroppable = input.turns.length > keepRecent;
  const shouldSummarise = exceedsThreshold && hasDroppable;
  const splitAt = Math.max(0, input.turns.length - keepRecent);
  return {
    shouldSummarise,
    keptTurns: shouldSummarise ? input.turns.slice(splitAt) : input.turns,
    droppedTurns: shouldSummarise ? input.turns.slice(0, splitAt) : [],
    estimatedTokens: estimated,
  };
}

/** Outcome surfaced by {@link summariseIfNeeded} — `skipped` or `summarised`. */
export type SummarisationOutcome =
  | { readonly status: 'skipped'; readonly reason: 'under_threshold' | 'no_droppable_turns' }
  | {
      readonly status: 'summarised';
      readonly summary: StructuredSummary;
      readonly keptTurns: readonly PersistedTurn[];
      readonly droppedTurnIndices: readonly number[];
    }
  | { readonly status: 'error'; readonly error: string };

export interface SummariseIfNeededInput extends SummariseThresholdInput {
  readonly summarizer: ConversationSummarizer;
}

/**
 * One-call entry: decide, summarise (if needed), return outcome. Callers
 * who want to inspect the decision before paying for a summarise call can
 * use {@link decideSummarisation} directly.
 */
export async function summariseIfNeeded(
  input: SummariseIfNeededInput,
): Promise<SummarisationOutcome> {
  const decision = decideSummarisation(input);
  if (!decision.shouldSummarise) {
    return {
      status: 'skipped',
      reason:
        decision.estimatedTokens > (input.thresholdTokens ?? DEFAULT_THRESHOLD_TOKENS)
          ? 'no_droppable_turns'
          : 'under_threshold',
    };
  }
  const result = await input.summarizer.summarize(decision.droppedTurns);
  if (!result.ok) {
    return { status: 'error', error: result.error };
  }
  return {
    status: 'summarised',
    summary: result.summary,
    keptTurns: decision.keptTurns,
    droppedTurnIndices: decision.droppedTurns.map((t) => t.turnIndex),
  };
}

/**
 * Format a {@link StructuredSummary} as an LLM `user` message ready to
 * splice into the conversation buffer as the new first message. The wire
 * format is deliberately stable + machine-parseable (markdown headings) so
 * the model treats it as authoritative recap rather than free-form chat.
 */
export function buildSummaryMessage(summary: StructuredSummary): LlmMessage {
  const text = [
    '[SUMMARY OF EARLIER CONVERSATION — authoritative recap of dropped turns]',
    '',
    '## Recent events',
    summary.recentEvents,
    '',
    '## Location context',
    summary.locationContext,
    '',
    '## NPC relationships',
    summary.npcRelationships,
    '',
    '## Open quests',
    summary.openQuests,
  ].join('\n');
  return {
    role: 'user',
    content: [{ type: 'text', text }],
  };
}

// ---------------------------------------------------------------------------
// LLM-backed summariser
// ---------------------------------------------------------------------------

export interface LlmConversationSummarizerOptions {
  readonly provider: LlmProvider;
  /**
   * Hard cap on output tokens for the summarise call. Defaults to 2048 —
   * enough for ~4-section structured summary with comfortable headroom,
   * not so much that a runaway model bills the world.
   */
  readonly maxTokens?: number;
  /**
   * Override the system prompt — primarily for tests asserting prompt
   * content. Production wiring should leave this as default.
   */
  readonly systemPrompt?: string;
}

const DEFAULT_SUMMARY_SYSTEM_PROMPT = [
  'You are summarising a long agent-driven RPG conversation so older turns can be',
  "dropped from the active context. Produce a JSON object with EXACTLY these four",
  'string fields and nothing else:',
  '',
  '  - recentEvents: chronological recap of notable beats (1-2 sentences each).',
  '  - locationContext: where the character is, how they got there, what is nearby.',
  '  - npcRelationships: named NPCs the character has interacted with + stance.',
  '  - openQuests: open quests, pending decisions, unresolved promises.',
  '',
  'Output the JSON object alone — no prose, no code fences, no commentary. If a',
  'field has no content, emit the empty string. Keep total output under 2000 tokens.',
].join('\n');

/**
 * Concrete `ConversationSummarizer` that issues one `generate()` call to
 * the supplied {@link LlmProvider}. Wrap the provider with
 * `TelemetryProvider` (with a `summarise:` tag) at the construction site
 * to surface summarisation cost in the same telemetry stream as everything
 * else.
 */
export class LlmConversationSummarizer implements ConversationSummarizer {
  #provider: LlmProvider;
  #maxTokens: number;
  #systemPrompt: string;

  constructor(opts: LlmConversationSummarizerOptions) {
    this.#provider = opts.provider;
    this.#maxTokens = opts.maxTokens ?? 2048;
    this.#systemPrompt = opts.systemPrompt ?? DEFAULT_SUMMARY_SYSTEM_PROMPT;
  }

  async summarize(
    turns: readonly PersistedTurn[],
  ): Promise<SummarizeResult> {
    if (turns.length === 0) {
      // Nothing to summarise — return empty structured summary.
      return {
        ok: true,
        summary: {
          recentEvents: '',
          locationContext: '',
          npcRelationships: '',
          openQuests: '',
        },
      };
    }
    const req: GenerateRequest = {
      system: [{ type: 'text', text: this.#systemPrompt }],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: renderTurnsForSummary(turns),
            },
          ],
        },
      ],
      maxTokens: this.#maxTokens,
    };
    const res: LlmResult<GenerateResult> = await this.#provider.generate(req);
    if (!res.ok) {
      return { ok: false, error: `llm: ${res.error.kind}: ${res.error.message}` };
    }
    const text = collectText(res.value.content);
    const parsed = tryParseStructuredSummary(text);
    if (!parsed.ok) {
      return { ok: false, error: `parse: ${parsed.error}` };
    }
    return { ok: true, summary: parsed.summary };
  }
}

/**
 * Render a list of turns into a single text block the summariser model
 * can read. Compact, lossless-enough — we keep user message, narration,
 * intents and tool calls; we drop tool args/results detail because the
 * summary is meant to be a recap, not a replay.
 */
export function renderTurnsForSummary(
  turns: readonly PersistedTurn[],
): string {
  const lines: string[] = [
    `Summarise the following ${turns.length} turns of agent-driven gameplay.`,
    `Turn indices ${turns[0]?.turnIndex} through ${turns[turns.length - 1]?.turnIndex}.`,
    '',
  ];
  for (const t of turns) {
    lines.push(`--- Turn ${t.turnIndex} (${t.timestamp}) ---`);
    if (t.userMessage) lines.push(`USER: ${t.userMessage}`);
    for (const lt of t.llmTurns) {
      if (lt.intent) lines.push(`INTENT: ${lt.intent}`);
      for (const tc of lt.toolCalls) {
        lines.push(`TOOL ${tc.tool} (${tc.status})`);
      }
      if (lt.narration) lines.push(`AGENT: ${lt.narration}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function collectText(content: readonly ContentBlock[]): string {
  return content
    .filter(isTextBlock)
    .map((b) => b.text)
    .join('');
}

function tryParseStructuredSummary(
  text: string,
):
  | { ok: true; summary: StructuredSummary }
  | { ok: false; error: string } {
  // Tolerate ```json fences in case the model wraps despite instructions.
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'top-level value is not an object' };
  }
  const obj = parsed as Record<string, unknown>;
  const fields: Array<keyof StructuredSummary> = [
    'recentEvents',
    'locationContext',
    'npcRelationships',
    'openQuests',
  ];
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = obj[f];
    if (typeof v !== 'string') {
      // Tolerate missing/null → empty string. Reject only wrong-type
      // (e.g. nested object) so the contract stays honest.
      if (v === undefined || v === null) {
        out[f] = '';
      } else {
        return { ok: false, error: `field '${f}' is not a string` };
      }
    } else {
      out[f] = v;
    }
  }
  return {
    ok: true,
    summary: out as unknown as StructuredSummary,
  };
}
