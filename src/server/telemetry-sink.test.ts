/**
 * Producer-side telemetry wiring (#725). The wire surface (the
 * `TelemetryEvent` shape + `EventHub.emitTelemetry`) is exercised by
 * `hub.test.ts`; this file proves the producer end — a
 * `TelemetryProvider` wrapping any `LlmProvider` lands a Channel-A
 * `telemetry` event on the hub for the right `(uid, characterId)`, with
 * `costUsd` derived from the central pricing table, and with the tag
 * stamped `${uid}:${characterId}` so jsonl / aggregator sinks downstream
 * stay joinable.
 */

import { describe, expect, it } from 'vitest';
import {
  createTelemetrySink,
  telemetryTag,
  wrapLlmWithTelemetry,
} from './telemetry-sink.js';
import { EventHub, type Subscriber } from './hub.js';
import {
  TelemetryProvider,
  arraySink,
  type TelemetryRecord,
} from '../llm/telemetry.js';
import { computeCostUsd } from '../llm/pricing.js';
import {
  type GenerateRequest,
  type GenerateResult,
  type LlmProvider,
  type LlmResult,
  type LlmUsage,
  type StreamEvent,
  llmOk,
} from '../llm/provider.js';
import type { ChannelAEvent, TelemetryEvent } from './wire.js';

/**
 * Tiny inline provider that always returns the same usage / model so the
 * pricing math is deterministic. Avoids pulling in `NoopProvider`'s
 * `ZERO_USAGE` (which would make every `costUsd` zero and not actually
 * exercise the "matches the pricing table" acceptance).
 */
class FixedProvider implements LlmProvider {
  readonly name = 'fixed';
  readonly #model: string;
  readonly #usage: LlmUsage;

  constructor(model: string, usage: LlmUsage) {
    this.#model = model;
    this.#usage = usage;
  }

  async generate(_req: GenerateRequest): Promise<LlmResult<GenerateResult>> {
    return llmOk({
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
      usage: this.#usage,
      model: this.#model,
    });
  }

  // eslint-disable-next-line require-yield
  async *streamGenerate(_req: GenerateRequest): AsyncIterable<StreamEvent> {
    throw new Error('not used by these tests');
  }
}

function collectFor(hub: EventHub, uid: string, characterId: string): ChannelAEvent[] {
  const events: ChannelAEvent[] = [];
  const sub: Subscriber = { id: 'spy', send: (e) => events.push(e) };
  hub.subscribe(uid, characterId, sub);
  return events;
}

describe('createTelemetrySink', () => {
  it('projects a TelemetryRecord onto the hub as a wire telemetry event', () => {
    const hub = new EventHub({ now: () => 1_700_000_000_000 });
    const events = collectFor(hub, 'uid-a', 'char-1');

    const sink = createTelemetrySink(hub, 'uid-a', 'char-1');
    const record: TelemetryRecord = {
      ts: '2026-05-25T00:00:00.000Z',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      mode: 'generate',
      ok: true,
      latencyMs: 432,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadInputTokens: 4000,
      cacheCreationInputTokens: 500,
      costUsd: 0.002725,
      cost: {
        input: 0.001,
        output: 0.001,
        cacheRead: 0.0004,
        cacheWrite: 0.000625,
        total: 0.002725,
        priced: true,
      },
      tag: 'uid-a:char-1',
    };

    sink(record);

    const telemetry = events.find((e) => e.type === 'telemetry') as
      | TelemetryEvent
      | undefined;
    expect(telemetry).toBeDefined();
    expect(telemetry!.uid).toBe('uid-a');
    expect(telemetry!.characterId).toBe('char-1');
    expect(telemetry!.provider).toBe('anthropic');
    expect(telemetry!.model).toBe('claude-haiku-4-5');
    expect(telemetry!.costUsd).toBe(0.002725);
    expect(telemetry!.inputTokens).toBe(1000);
    expect(telemetry!.outputTokens).toBe(200);
    expect(telemetry!.cacheReadInputTokens).toBe(4000);
    expect(telemetry!.cacheCreationInputTokens).toBe(500);
    expect(telemetry!.latencyMs).toBe(432);
    // Wire event drops per-bucket cost split + ok/mode/errorKind/ts —
    // those stay in the jsonl path.
    expect((telemetry as unknown as { cost?: unknown }).cost).toBeUndefined();
    expect((telemetry as unknown as { mode?: unknown }).mode).toBeUndefined();
  });

  it('only fans out to the stream keyed by (uid, characterId)', () => {
    const hub = new EventHub();
    const seenA = collectFor(hub, 'uid-a', 'char-1');
    const seenOther = collectFor(hub, 'uid-b', 'char-1');

    const sink = createTelemetrySink(hub, 'uid-a', 'char-1');
    sink({
      ts: '',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      mode: 'generate',
      ok: true,
      latencyMs: 10,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, priced: true },
    });

    expect(seenA.filter((e) => e.type === 'telemetry')).toHaveLength(1);
    expect(seenOther.filter((e) => e.type === 'telemetry')).toHaveLength(0);
  });

  it('swallows hub errors so telemetry never breaks the agent loop', () => {
    // Stub hub whose emitTelemetry throws.
    const bad = {
      emitTelemetry: () => {
        throw new Error('disk full');
      },
    } as unknown as EventHub;
    const sink = createTelemetrySink(bad, 'u', 'c');
    expect(() =>
      sink({
        ts: '',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        mode: 'generate',
        ok: true,
        latencyMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUsd: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, priced: true },
      }),
    ).not.toThrow();
  });
});

describe('telemetryTag', () => {
  it('matches the EventHub stream key format', () => {
    expect(telemetryTag('uid-a', 'char-1')).toBe('uid-a:char-1');
  });
});

describe('wrapLlmWithTelemetry — end-to-end via TelemetryProvider', () => {
  it('emits one wire telemetry event per generate(), with costUsd matching the pricing table', async () => {
    const hub = new EventHub();
    const events = collectFor(hub, 'uid-a', 'char-1');

    const usage: LlmUsage = {
      inputTokens: 1_000_000, // 1M tokens — yields exactly $1 input on haiku-4-5
      outputTokens: 200_000, // 200k * $5/M = $1
      cacheReadInputTokens: 100_000, // 100k * $0.1/M = $0.01
      cacheCreationInputTokens: 0,
    };
    const expectedCost = computeCostUsd('claude-haiku-4-5', usage).total;
    expect(expectedCost).toBeCloseTo(2.01, 4);

    const wrapped = wrapLlmWithTelemetry(
      new FixedProvider('claude-haiku-4-5', usage),
      hub,
      'uid-a',
      'char-1',
    );
    expect(wrapped).toBeInstanceOf(TelemetryProvider);

    await wrapped.generate({ messages: [], tools: [] });

    const telemetry = events.find((e) => e.type === 'telemetry') as
      | TelemetryEvent
      | undefined;
    expect(telemetry).toBeDefined();
    expect(telemetry!.model).toBe('claude-haiku-4-5');
    expect(telemetry!.provider).toBe('fixed');
    expect(telemetry!.costUsd).toBeCloseTo(expectedCost, 8);
    expect(telemetry!.inputTokens).toBe(1_000_000);
    expect(telemetry!.outputTokens).toBe(200_000);
    expect(telemetry!.cacheReadInputTokens).toBe(100_000);
  });

  it('tags records with `${uid}:${characterId}` for cross-character cost analysis', async () => {
    // Tag flows on TelemetryRecord, not the wire event — wire is per-stream
    // by construction. Verify by pointing the underlying TelemetryProvider
    // at an `arraySink` alongside.
    const records: TelemetryRecord[] = [];

    const inner = new FixedProvider('claude-haiku-4-5', {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    // Mirror what wrapLlmWithTelemetry does but also capture records.
    const sinkChained = (r: TelemetryRecord): void => {
      records.push(r);
    };
    const tp = new TelemetryProvider({
      inner,
      sink: sinkChained,
      tag: telemetryTag('uid-x', 'char-y'),
    });

    await tp.generate({ messages: [], tools: [] });

    expect(records).toHaveLength(1);
    expect(records[0].tag).toBe('uid-x:char-y');
  });

  it('does not break when paired with the captured arraySink + hub sink (composition smoke)', async () => {
    // The future `SessionFactory` will compose sinks (jsonl for offline
    // analysis + hub for the live wire). Smoke-test that order doesn't
    // matter: hub-then-array yields the same records.
    const hub = new EventHub();
    const events = collectFor(hub, 'u', 'c');
    const recs: TelemetryRecord[] = [];
    const hubSink = createTelemetrySink(hub, 'u', 'c');
    const both = (r: TelemetryRecord) => {
      hubSink(r);
      arraySink(recs)(r);
    };
    const tp = new TelemetryProvider({
      inner: new FixedProvider('claude-haiku-4-5', {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      }),
      sink: both,
      tag: 'u:c',
    });

    await tp.generate({ messages: [], tools: [] });

    expect(recs).toHaveLength(1);
    expect(events.filter((e) => e.type === 'telemetry')).toHaveLength(1);
  });
});
