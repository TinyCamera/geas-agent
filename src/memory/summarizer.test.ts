import { describe, it, expect } from 'vitest';
import { NoopProvider } from '../llm/noop.js';
import { TelemetryProvider, arraySink, type TelemetryRecord } from '../llm/telemetry.js';
import type { PersistedTurn } from '../persistence/conversation-store.js';
import {
  DEFAULT_KEEP_RECENT_TURNS,
  DEFAULT_THRESHOLD_TOKENS,
  LlmConversationSummarizer,
  buildSummaryMessage,
  decideSummarisation,
  estimateBufferTokens,
  estimateTurnTokens,
  renderTurnsForSummary,
  summariseIfNeeded,
  type StructuredSummary,
} from './summarizer.js';

function makeTurn(
  turnIndex: number,
  overrides: Partial<PersistedTurn> = {},
): PersistedTurn {
  return {
    turnIndex,
    sessionId: 'sess-abc',
    characterId: 'char-1',
    displayName: 'Vargen',
    timestamp: `2026-05-25T00:00:${String(turnIndex).padStart(2, '0')}.000Z`,
    userMessage: `say hi turn ${turnIndex}`,
    llmTurns: [
      {
        intent: turnIndex % 2 === 0 ? 'scout' : null,
        toolCalls: [
          { tool: 'look', args: { range: 5 }, status: 'ok', attempts: 1 },
        ],
        narration: `narration ${turnIndex}`.repeat(2),
      },
    ],
    tokenUsage: {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    totalCostUsd: 0.01,
    ...overrides,
  };
}

const STRUCTURED: StructuredSummary = {
  recentEvents: 'Vargen entered the crypt and slew a ghoul.',
  locationContext: 'Crypt entrance, lower city.',
  npcRelationships: 'Sergeant Polk: ally; Mortimer: hostile.',
  openQuests: 'Recover the lost reliquary.',
};

describe('estimateTurnTokens', () => {
  it('prefers reported usage when present', () => {
    const t = makeTurn(0);
    expect(estimateTurnTokens(t)).toBe(1200);
  });

  it('falls back to char-based estimate when usage is zero', () => {
    const t = makeTurn(0, {
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    });
    const est = estimateTurnTokens(t);
    expect(est).toBeGreaterThan(0);
    expect(est).toBeLessThan(1000);
  });
});

describe('decideSummarisation', () => {
  it('skips below threshold', () => {
    const turns = Array.from({ length: 5 }, (_, i) => makeTurn(i));
    const d = decideSummarisation({ turns });
    expect(d.shouldSummarise).toBe(false);
    expect(d.droppedTurns).toEqual([]);
    expect(d.keptTurns.length).toBe(5);
  });

  it('triggers when threshold exceeded and there are droppable turns', () => {
    const turns = Array.from({ length: 20 }, (_, i) => makeTurn(i));
    const d = decideSummarisation({
      turns,
      thresholdTokens: 1000, // tiny so any history trips it
      keepRecentTurns: 5,
    });
    expect(d.shouldSummarise).toBe(true);
    expect(d.keptTurns.length).toBe(5);
    expect(d.droppedTurns.length).toBe(15);
    expect(d.droppedTurns[0]?.turnIndex).toBe(0);
    expect(d.keptTurns[0]?.turnIndex).toBe(15);
  });

  it('does not summarise when buffer is at or under keepRecentTurns', () => {
    const turns = Array.from({ length: 5 }, (_, i) => makeTurn(i));
    const d = decideSummarisation({
      turns,
      thresholdTokens: 10, // would trip threshold...
      keepRecentTurns: 5, // ...but nothing is droppable
    });
    expect(d.shouldSummarise).toBe(false);
  });

  it('uses sane defaults for threshold + keepRecent', () => {
    const turns = Array.from({ length: 5 }, (_, i) => makeTurn(i));
    const d = decideSummarisation({ turns });
    expect(d.estimatedTokens).toBe(estimateBufferTokens(turns));
    expect(d.shouldSummarise).toBe(false);
    // Default thresholds are sensible
    expect(DEFAULT_KEEP_RECENT_TURNS).toBe(10);
    expect(DEFAULT_THRESHOLD_TOKENS).toBeGreaterThan(100_000);
  });
});

describe('renderTurnsForSummary', () => {
  it('includes user, intent, tool, narration lines', () => {
    const text = renderTurnsForSummary([makeTurn(0), makeTurn(1)]);
    expect(text).toContain('Turn 0');
    expect(text).toContain('USER: say hi turn 0');
    expect(text).toContain('INTENT: scout');
    expect(text).toContain('TOOL look (ok)');
    expect(text).toContain('AGENT: narration 0');
  });
});

describe('LlmConversationSummarizer', () => {
  it('parses a clean JSON object from the model', async () => {
    const provider = new NoopProvider({
      script: [
        {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(STRUCTURED) }],
        },
      ],
    });
    const s = new LlmConversationSummarizer({ provider });
    const r = await s.summarize([makeTurn(0), makeTurn(1)]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.summary).toEqual(STRUCTURED);
  });

  it('tolerates code fences around the JSON', async () => {
    const provider = new NoopProvider({
      script: [
        {
          stopReason: 'end_turn',
          content: [
            {
              type: 'text',
              text: '```json\n' + JSON.stringify(STRUCTURED) + '\n```',
            },
          ],
        },
      ],
    });
    const s = new LlmConversationSummarizer({ provider });
    const r = await s.summarize([makeTurn(0)]);
    expect(r.ok).toBe(true);
  });

  it('returns ok:false on malformed JSON', async () => {
    const provider = new NoopProvider({
      script: [
        {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: 'not json at all' }],
        },
      ],
    });
    const s = new LlmConversationSummarizer({ provider });
    const r = await s.summarize([makeTurn(0)]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toMatch(/parse/);
  });

  it('returns ok:false on provider error', async () => {
    const provider = new NoopProvider({
      script: [{ error: { kind: 'rate_limit', message: 'slow down' } }],
    });
    const s = new LlmConversationSummarizer({ provider });
    const r = await s.summarize([makeTurn(0)]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toMatch(/rate_limit/);
  });

  it('short-circuits with empty summary on empty input', async () => {
    const provider = new NoopProvider({ script: [] });
    const s = new LlmConversationSummarizer({ provider });
    const r = await s.summarize([]);
    expect(r.ok).toBe(true);
    expect(provider.requests.length).toBe(0);
  });

  it('tolerates missing fields by emitting empty strings', async () => {
    const provider = new NoopProvider({
      script: [
        {
          stopReason: 'end_turn',
          content: [
            {
              type: 'text',
              text: JSON.stringify({ recentEvents: 'just this' }),
            },
          ],
        },
      ],
    });
    const s = new LlmConversationSummarizer({ provider });
    const r = await s.summarize([makeTurn(0)]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.summary.recentEvents).toBe('just this');
    expect(r.summary.locationContext).toBe('');
  });

  it('surfaces a telemetry record when wrapped (cost line per #612)', async () => {
    const inner = new NoopProvider({
      script: [
        {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(STRUCTURED) }],
          model: 'claude-haiku-4-5',
        },
      ],
    });
    const records: TelemetryRecord[] = [];
    const wrapped = new TelemetryProvider({
      inner,
      sink: arraySink(records),
      tag: 'summarise:char-1',
    });
    const s = new LlmConversationSummarizer({ provider: wrapped });
    await s.summarize([makeTurn(0)]);
    expect(records.length).toBe(1);
    expect(records[0]?.tag).toBe('summarise:char-1');
    expect(records[0]?.ok).toBe(true);
  });
});

describe('summariseIfNeeded', () => {
  it('skips when under threshold', async () => {
    const summarizer = new LlmConversationSummarizer({
      provider: new NoopProvider(),
    });
    const r = await summariseIfNeeded({
      turns: [makeTurn(0)],
      summarizer,
    });
    expect(r.status).toBe('skipped');
  });

  it('summarises and returns kept + dropped indices when triggered', async () => {
    const turns = Array.from({ length: 20 }, (_, i) => makeTurn(i));
    const provider = new NoopProvider({
      script: [
        {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(STRUCTURED) }],
        },
      ],
    });
    const summarizer = new LlmConversationSummarizer({ provider });
    const r = await summariseIfNeeded({
      turns,
      summarizer,
      thresholdTokens: 1000,
      keepRecentTurns: 5,
    });
    expect(r.status).toBe('summarised');
    if (r.status !== 'summarised') throw new Error('unreachable');
    expect(r.keptTurns.length).toBe(5);
    expect(r.droppedTurnIndices).toEqual(
      Array.from({ length: 15 }, (_, i) => i),
    );
    expect(r.summary).toEqual(STRUCTURED);
  });

  it('surfaces error status on summariser failure', async () => {
    const turns = Array.from({ length: 20 }, (_, i) => makeTurn(i));
    const provider = new NoopProvider({
      script: [{ error: { kind: 'overloaded', message: 'try later' } }],
    });
    const summarizer = new LlmConversationSummarizer({ provider });
    const r = await summariseIfNeeded({
      turns,
      summarizer,
      thresholdTokens: 1000,
      keepRecentTurns: 5,
    });
    expect(r.status).toBe('error');
  });
});

describe('buildSummaryMessage', () => {
  it('builds a user-role message embedding all four sections', () => {
    const msg = buildSummaryMessage(STRUCTURED);
    expect(msg.role).toBe('user');
    expect(msg.content.length).toBe(1);
    const block = msg.content[0];
    if (!block || block.type !== 'text') throw new Error('expected text block');
    expect(block.text).toContain('SUMMARY OF EARLIER CONVERSATION');
    expect(block.text).toContain('Recent events');
    expect(block.text).toContain(STRUCTURED.recentEvents);
    expect(block.text).toContain(STRUCTURED.locationContext);
    expect(block.text).toContain(STRUCTURED.npcRelationships);
    expect(block.text).toContain(STRUCTURED.openQuests);
  });
});

describe('50-turn fits-in-context scenario (acceptance)', () => {
  it('compresses 50 turns of fat history so post-summarise prompt is bounded', async () => {
    // Simulate 50 turns of high-token usage.
    const turns: PersistedTurn[] = Array.from({ length: 50 }, (_, i) =>
      makeTurn(i, {
        tokenUsage: {
          inputTokens: 5000,
          outputTokens: 500,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      }),
    );
    // Sanity: raw buffer is well over a small model's budget.
    const rawBudget = estimateBufferTokens(turns);
    expect(rawBudget).toBeGreaterThan(200_000);

    const provider = new NoopProvider({
      script: [
        {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(STRUCTURED) }],
        },
      ],
    });
    const summarizer = new LlmConversationSummarizer({ provider });
    const r = await summariseIfNeeded({
      turns,
      summarizer,
      // Use a tighter budget so we exercise the trigger.
      thresholdTokens: 100_000,
      keepRecentTurns: 10,
    });

    expect(r.status).toBe('summarised');
    if (r.status !== 'summarised') throw new Error('unreachable');
    expect(r.keptTurns.length).toBe(10);
    expect(r.droppedTurnIndices.length).toBe(40);

    // Post-summarisation buffer: the summary message + the 10 kept turns.
    // The summary message is bounded by output-token cap (<= ~2k tokens).
    const summaryMsg = buildSummaryMessage(r.summary);
    const summaryText = summaryMsg.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');
    const summaryTokens = Math.ceil(summaryText.length / 4);
    const keptTokens = estimateBufferTokens(r.keptTurns);
    const totalAfter = summaryTokens + keptTokens;

    expect(totalAfter).toBeLessThan(rawBudget);
    // And bounded by our threshold + headroom.
    expect(totalAfter).toBeLessThan(100_000);
  });
});
