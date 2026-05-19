/**
 * Telemetry tests.
 *
 * Covers the #612 acceptance:
 *   - one record per generate / streamGenerate call (the provider boundary);
 *   - synthetic usage → expected $ and per-active-char-hour aggregate;
 *   - jsonl line is flat & round-trips through CostAggregator.fromJsonl
 *     (parseable like #585's log.jsonl);
 *   - a throwing sink never breaks the wrapped call.
 *
 * The inner provider is a hand-rolled stub implementing `LlmProvider` — no SDK,
 * no network. We assert the *records*, not vendor wire shape (that's
 * anthropic.test.ts's job).
 */
import { describe, it, expect } from 'vitest';
import {
  TelemetryProvider,
  CostAggregator,
  jsonlSink,
  arraySink,
  type TelemetryRecord,
} from './telemetry.js';
import {
  type GenerateRequest,
  type GenerateResult,
  type LlmProvider,
  type LlmResult,
  type LlmUsage,
  type StreamEvent,
  llmOk,
  llmErr,
  makeLlmError,
} from './provider.js';

const REQ: GenerateRequest = {
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
};

const usage = (u: Partial<LlmUsage>): LlmUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  ...u,
});

/** Stub provider: one canned result for generate, scripted events for stream. */
class StubProvider implements LlmProvider {
  readonly name = 'stub';
  constructor(
    private genResult: LlmResult<GenerateResult>,
    private streamEvents: StreamEvent[] = [],
  ) {}
  async generate(): Promise<LlmResult<GenerateResult>> {
    return this.genResult;
  }
  async *streamGenerate(): AsyncIterable<StreamEvent> {
    for (const e of this.streamEvents) yield e;
  }
}

function fakeClock(times: number[]): () => number {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
}

describe('TelemetryProvider.generate', () => {
  it('emits exactly one record per call with priced cost + tokens', async () => {
    const records: TelemetryRecord[] = [];
    const inner = new StubProvider(
      llmOk({
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
        usage: usage({
          inputTokens: 10_000,
          outputTokens: 2_000,
          cacheReadInputTokens: 100_000,
          cacheCreationInputTokens: 8_000,
        }),
        model: 'claude-haiku-4-5',
      }),
    );
    const tp = new TelemetryProvider({
      inner,
      sink: arraySink(records),
      now: fakeClock([1_000, 1_350]),
      tag: 'char-7',
    });

    const res = await tp.generate(REQ);

    expect(res.ok).toBe(true);
    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r.provider).toBe('stub');
    expect(r.model).toBe('claude-haiku-4-5');
    expect(r.mode).toBe('generate');
    expect(r.ok).toBe(true);
    expect(r.latencyMs).toBe(350);
    expect(r.inputTokens).toBe(10_000);
    expect(r.cacheReadInputTokens).toBe(100_000);
    // 0.01 + 0.01 + 0.01 + 0.01 = 0.04 (see pricing.test.ts arithmetic)
    expect(r.costUsd).toBeCloseTo(0.04, 10);
    expect(r.cost.priced).toBe(true);
    expect(r.tag).toBe('char-7');
    expect(r.ts).toBe(new Date(1_350).toISOString());
  });

  it('passes the wrapped result through unchanged (transparent decorator)', async () => {
    const inner = new StubProvider(
      llmOk({
        stopReason: 'tool_use',
        content: [{ type: 'tool_use', id: 'x', name: 'look', input: {} }],
        usage: usage({ inputTokens: 1 }),
        model: 'claude-haiku-4-5',
      }),
    );
    const tp = new TelemetryProvider({ inner, sink: () => {} });
    const res = await tp.generate(REQ);
    expect(res.ok && res.value.stopReason).toBe('tool_use');
    expect(res.ok && res.value.content[0].type).toBe('tool_use');
  });

  it('records a provider error with errorKind and zeroed usage/cost', async () => {
    const records: TelemetryRecord[] = [];
    const inner = new StubProvider(
      llmErr(makeLlmError('rate_limit', 'slow down')),
    );
    const tp = new TelemetryProvider({ inner, sink: arraySink(records) });
    const res = await tp.generate(REQ);
    expect(res.ok).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0].ok).toBe(false);
    expect(records[0].errorKind).toBe('rate_limit');
    expect(records[0].costUsd).toBe(0);
  });

  it('flags an unpriced model (cost 0 but priced=false)', async () => {
    const records: TelemetryRecord[] = [];
    const inner = new StubProvider(
      llmOk({
        stopReason: 'end_turn',
        content: [],
        usage: usage({ inputTokens: 5_000_000 }),
        model: 'mystery-model',
      }),
    );
    const tp = new TelemetryProvider({ inner, sink: arraySink(records) });
    await tp.generate(REQ);
    expect(records[0].cost.priced).toBe(false);
    expect(records[0].costUsd).toBe(0);
    expect(records[0].model).toBe('mystery-model');
  });

  it('falls back to defaultModel when the result omits a model id', async () => {
    const records: TelemetryRecord[] = [];
    const inner = new StubProvider(
      llmOk({ stopReason: 'end_turn', content: [], usage: usage({}) }),
    );
    const tp = new TelemetryProvider({
      inner,
      sink: arraySink(records),
      defaultModel: 'claude-haiku-4-5',
    });
    await tp.generate(REQ);
    expect(records[0].model).toBe('claude-haiku-4-5');
  });

  it('a throwing sink does not fail the call', async () => {
    const inner = new StubProvider(
      llmOk({ stopReason: 'end_turn', content: [], usage: usage({}) }),
    );
    const tp = new TelemetryProvider({
      inner,
      sink: () => {
        throw new Error('disk full');
      },
    });
    const res = await tp.generate(REQ);
    expect(res.ok).toBe(true);
  });

  it('a rejecting async sink does not produce an unhandled rejection', async () => {
    const inner = new StubProvider(
      llmOk({ stopReason: 'end_turn', content: [], usage: usage({}) }),
    );
    const tp = new TelemetryProvider({
      inner,
      sink: async () => {
        throw new Error('async sink boom');
      },
    });
    const res = await tp.generate(REQ);
    expect(res.ok).toBe(true);
  });
});

describe('TelemetryProvider.streamGenerate', () => {
  it('emits one record on the terminal result event and forwards all events', async () => {
    const records: TelemetryRecord[] = [];
    const inner = new StubProvider(llmOk({} as GenerateResult), [
      { type: 'text_delta', text: 'he' },
      { type: 'text_delta', text: 'llo' },
      {
        type: 'result',
        result: {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: 'hello' }],
          usage: usage({ inputTokens: 1_000_000 }),
          model: 'claude-haiku-4-5',
        },
      },
    ]);
    const tp = new TelemetryProvider({
      inner,
      sink: arraySink(records),
      // streamGenerate reads now() once at start, once on the terminal event.
      now: fakeClock([100, 600]),
    });

    const seen: string[] = [];
    for await (const ev of tp.streamGenerate(REQ)) seen.push(ev.type);

    expect(seen).toEqual(['text_delta', 'text_delta', 'result']);
    expect(records).toHaveLength(1);
    expect(records[0].mode).toBe('stream');
    expect(records[0].ok).toBe(true);
    expect(records[0].latencyMs).toBe(500);
    expect(records[0].costUsd).toBeCloseTo(1.0, 10); // 1M in @ $1
  });

  it('emits one error record on a terminal error event', async () => {
    const records: TelemetryRecord[] = [];
    const inner = new StubProvider(llmOk({} as GenerateResult), [
      { type: 'error', error: makeLlmError('overloaded', 'try later') },
    ]);
    const tp = new TelemetryProvider({ inner, sink: arraySink(records) });
    // drain
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of tp.streamGenerate(REQ)) { /* noop */ }
    expect(records).toHaveLength(1);
    expect(records[0].ok).toBe(false);
    expect(records[0].errorKind).toBe('overloaded');
  });

  it('still emits exactly one record if the stream ends with no terminal event', async () => {
    const records: TelemetryRecord[] = [];
    const inner = new StubProvider(llmOk({} as GenerateResult), [
      { type: 'text_delta', text: 'partial' },
    ]);
    const tp = new TelemetryProvider({ inner, sink: arraySink(records) });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of tp.streamGenerate(REQ)) { /* noop */ }
    expect(records).toHaveLength(1);
    expect(records[0].ok).toBe(false);
    expect(records[0].errorKind).toBe('incomplete');
  });
});

describe('jsonlSink + CostAggregator (parseable like #585 log.jsonl)', () => {
  it('writes one flat JSON line per record and round-trips through fromJsonl', async () => {
    let buf = '';
    const sink = jsonlSink({ write: (s: string) => (buf += s) });
    const inner = new StubProvider(
      llmOk({
        stopReason: 'end_turn',
        content: [],
        usage: usage({ inputTokens: 1_000_000, outputTokens: 200_000 }),
        model: 'claude-haiku-4-5',
      }),
    );
    const tp = new TelemetryProvider({ inner, sink });

    await tp.generate(REQ);
    await tp.generate(REQ);

    const lines = buf.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    // each line is a standalone parseable object
    for (const line of lines) {
      const obj = JSON.parse(line);
      expect(obj.model).toBe('claude-haiku-4-5');
      expect(typeof obj.costUsd).toBe('number');
    }

    const agg = CostAggregator.fromJsonl(buf);
    const s = agg.summary();
    expect(s.calls).toBe(2);
    expect(s.okCalls).toBe(2);
    expect(s.totalCostUsd).toBeCloseTo(4.0, 10); // 2 calls × ($1 in + $1 out)
    expect(s.inputTokens).toBe(2_000_000);
  });
});

describe('CostAggregator → $/active-character-hour (the #585 metric)', () => {
  const rec = (over: Partial<TelemetryRecord>): TelemetryRecord => ({
    ts: new Date(0).toISOString(),
    provider: 'stub',
    model: 'claude-haiku-4-5',
    mode: 'generate',
    ok: true,
    latencyMs: 100,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      priced: true,
    },
    ...over,
  });

  it('extrapolates total cost over the declared active wall-clock', () => {
    const agg = new CostAggregator();
    // 50 calls, $0.001 each = $0.05 over 30 active minutes → $0.10 / hr
    for (let i = 0; i < 50; i++) agg.add(rec({ costUsd: 0.001 }));
    agg.activeMs(30 * 60_000);
    const s = agg.summary();
    expect(s.totalCostUsd).toBeCloseTo(0.05, 10);
    expect(s.costPerActiveCharHourUsd).toBeCloseTo(0.1, 10);
    expect(s.calls).toBe(50);
  });

  it('reports null per-hour until active time is declared (no fabricated rate)', () => {
    const agg = new CostAggregator();
    agg.add(rec({ costUsd: 0.02 }));
    expect(agg.summary().costPerActiveCharHourUsd).toBeNull();
  });

  it('counts unpriced ok-calls so an undercounted total is visible', () => {
    const agg = new CostAggregator();
    agg.add(rec({ costUsd: 0.01 }));
    agg.add(
      rec({
        costUsd: 0,
        model: 'mystery',
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
          priced: false,
        },
      }),
    );
    const s = agg.summary();
    expect(s.calls).toBe(2);
    expect(s.unpricedCalls).toBe(1);
  });

  it('separates ok vs error call counts', () => {
    const agg = new CostAggregator();
    agg.add(rec({ ok: true }));
    agg.add(rec({ ok: false, errorKind: 'rate_limit' }));
    agg.add(rec({ ok: false, errorKind: 'timeout' }));
    const s = agg.summary();
    expect(s.okCalls).toBe(1);
    expect(s.errorCalls).toBe(2);
  });
});
