/**
 * Cost + token telemetry at the provider boundary (#612, parent #584).
 *
 * **Why a decorator, not a change to each provider.** Every concrete provider
 * already reports `LlmUsage` (#609 design constraint 2). What's missing is: one
 * structured record per call, priced, timestamped, aggregable to
 * `$/active-character-hour` (the #585 viability metric). Putting that in
 * `AnthropicProvider` would (a) duplicate into every future vendor adapter and
 * (b) tangle pricing/IO into the vendor seam. So `TelemetryProvider` *wraps*
 * any {@link LlmProvider}, is transparent to callers (same interface), and is
 * the single place a telemetry record is born — including for `streamGenerate`,
 * where the record is emitted once on the terminal `result`/`error` event.
 *
 * **The jsonl line.** One {@link TelemetryRecord} per call, written as a single
 * JSON line by {@link jsonlSink}. Parseable like #585's benchmark `log.jsonl`:
 * flat, one object per line, every field primitive. A scenario run that wires
 * `jsonlSink(fs.createWriteStream('log.jsonl'))` emits exactly the artifact
 * #585's acceptance asks for; `CostAggregator` turns the stream into the
 * single-table summary.
 *
 * **Never let telemetry break the agent loop.** A sink that throws (disk full,
 * bad stream) must not turn a successful `generate` into a failure — the
 * provider contract is "never throw on transport". Sink errors are swallowed
 * (best-effort observability), mirroring `GeasMcpClient`'s non-throwing stance.
 */

import {
  type GenerateRequest,
  type GenerateResult,
  type LlmProvider,
  type LlmResult,
  type LlmUsage,
  type StreamEvent,
} from './provider.js';
import { computeCostUsd, type CostBreakdownUsd } from './pricing.js';

/**
 * One emitted call record. Flat by design so a downstream `JSON.parse` per
 * line yields a directly-tabulatable row (no nested digging) — matches the
 * #585 `log.jsonl` ergonomics.
 */
export interface TelemetryRecord {
  /** ISO-8601 UTC, call completion time. */
  readonly ts: string;
  /** Provider name (`anthropic`, `noop`, …) — `LlmProvider.name`. */
  readonly provider: string;
  /** Resolved model id the call reported, or the requested id as a fallback. */
  readonly model: string;
  /** `generate` or `streamGenerate`. */
  readonly mode: 'generate' | 'stream';
  /** True iff the call returned a result (vs. a typed provider error). */
  readonly ok: boolean;
  /** Present only when `ok` is false. */
  readonly errorKind?: string;
  /** Wall-clock for the call, ms. For streams: start → terminal event. */
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  /** USD cost of this single call (sum of the priced buckets). */
  readonly costUsd: number;
  /** Per-bucket USD split, for cache-efficiency analysis. */
  readonly cost: CostBreakdownUsd;
  /**
   * Optional caller-supplied tag so records can be grouped (e.g. one value per
   * character / scenario run) when aggregating `$/active-character-hour`.
   */
  readonly tag?: string;
}

/** Where a {@link TelemetryRecord} goes. Sync or async; errors are swallowed. */
export type TelemetrySink = (record: TelemetryRecord) => void | Promise<void>;

export interface TelemetryProviderOptions {
  /** The provider to wrap. */
  readonly inner: LlmProvider;
  /** Called once per `generate` / `streamGenerate` call. */
  readonly sink: TelemetrySink;
  /**
   * Falls back to this model id when a result doesn't echo one (errors, or a
   * provider that omits `model`). Defaults to `'unknown'`.
   */
  readonly defaultModel?: string;
  /** Static tag stamped on every record (e.g. the active character id). */
  readonly tag?: string;
  /** Clock seam for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

const ZERO: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

/**
 * Transparent {@link LlmProvider} decorator that emits one
 * {@link TelemetryRecord} per call. Implements the same interface, so it drops
 * in anywhere a provider is expected; the agent loop never knows it's there.
 */
export class TelemetryProvider implements LlmProvider {
  readonly name: string;

  #inner: LlmProvider;
  #sink: TelemetrySink;
  #defaultModel: string;
  #tag?: string;
  #now: () => number;

  constructor(opts: TelemetryProviderOptions) {
    this.#inner = opts.inner;
    this.#sink = opts.sink;
    this.#defaultModel = opts.defaultModel ?? 'unknown';
    this.#tag = opts.tag;
    this.#now = opts.now ?? Date.now;
    this.name = opts.inner.name;
  }

  async generate(req: GenerateRequest): Promise<LlmResult<GenerateResult>> {
    const started = this.#now();
    const res = await this.#inner.generate(req);
    const latencyMs = this.#now() - started;
    if (res.ok) {
      this.#emit('generate', true, res.value.model, res.value.usage, latencyMs);
    } else {
      this.#emit(
        'generate',
        false,
        undefined,
        ZERO,
        latencyMs,
        res.error.kind,
      );
    }
    return res;
  }

  async *streamGenerate(req: GenerateRequest): AsyncIterable<StreamEvent> {
    const started = this.#now();
    let emitted = false;
    try {
      for await (const ev of this.#inner.streamGenerate(req)) {
        if (ev.type === 'result') {
          this.#emit(
            'stream',
            true,
            ev.result.model,
            ev.result.usage,
            this.#now() - started,
          );
          emitted = true;
        } else if (ev.type === 'error') {
          this.#emit(
            'stream',
            false,
            undefined,
            ZERO,
            this.#now() - started,
            ev.error.kind,
          );
          emitted = true;
        }
        yield ev;
      }
    } finally {
      // A stream that ends without a terminal event (consumer broke early, or
      // a provider bug) still gets exactly one record so call-count accounting
      // never silently under-counts.
      if (!emitted) {
        this.#emit('stream', false, undefined, ZERO, this.#now() - started, 'incomplete');
      }
    }
  }

  #emit(
    mode: TelemetryRecord['mode'],
    ok: boolean,
    model: string | undefined,
    usage: LlmUsage,
    latencyMs: number,
    errorKind?: string,
  ): void {
    const resolvedModel = model ?? this.#defaultModel;
    const cost = computeCostUsd(model, usage);
    const record: TelemetryRecord = {
      ts: new Date(this.#now()).toISOString(),
      provider: this.name,
      model: resolvedModel,
      mode,
      ok,
      ...(errorKind ? { errorKind } : {}),
      latencyMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      costUsd: cost.total,
      cost,
      ...(this.#tag ? { tag: this.#tag } : {}),
    };
    try {
      // Best-effort: a throwing/ rejecting sink must never fail the call.
      const r = this.#sink(record);
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch(() => {});
      }
    } catch {
      /* swallowed — telemetry is observability, not control flow */
    }
  }
}

/**
 * A {@link TelemetrySink} that writes one JSON line per record to a
 * `{ write(s: string) }` target (a Node `WriteStream`, or any buffer with a
 * `write`). One object per line, flat — `cat log.jsonl | jq` works, and
 * {@link CostAggregator.fromJsonl} round-trips it.
 */
export function jsonlSink(out: { write(s: string): unknown }): TelemetrySink {
  return (record) => {
    out.write(JSON.stringify(record) + '\n');
  };
}

/** An in-memory sink — collects records for tests / a same-process summary. */
export function arraySink(into: TelemetryRecord[]): TelemetrySink {
  return (record) => {
    into.push(record);
  };
}

export interface CostSummary {
  readonly calls: number;
  readonly okCalls: number;
  readonly errorCalls: number;
  readonly totalCostUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  /** Sum of per-call latencies, ms. */
  readonly totalLatencyMs: number;
  /** Number of records whose model had no price row (cost undercounted). */
  readonly unpricedCalls: number;
  /**
   * The #585 viability metric: total cost extrapolated to one
   * active-character-hour of agent activity. `null` until the aggregator has
   * been told how much wall-clock the records represent (see
   * {@link CostAggregator.activeMs}); a one-call sample can't imply a rate.
   */
  readonly costPerActiveCharHourUsd: number | null;
}

/**
 * Rolls {@link TelemetryRecord}s into a {@link CostSummary} — the
 * single-table summary #585's acceptance asks a scenario run to print.
 *
 * **Why active-time is injected, not derived from record timestamps.** A run's
 * wall-clock includes the human/MCP round-trips between LLM calls; "active
 * character hour" is the hour the *character* was being driven, which the
 * scenario knows (it owns the session clock) and the telemetry stream does
 * not. So the scenario tells the aggregator the active duration via
 * {@link activeMs}; `$/hr` is `totalCost / activeHours`. Without it the rate is
 * `null` rather than a fabricated number.
 */
export class CostAggregator {
  #calls = 0;
  #ok = 0;
  #err = 0;
  #cost = 0;
  #in = 0;
  #out = 0;
  #cacheRead = 0;
  #cacheCreate = 0;
  #latency = 0;
  #unpriced = 0;
  #activeMs: number | null = null;

  /** Fold one record into the running totals. */
  add(record: TelemetryRecord): void {
    this.#calls += 1;
    if (record.ok) this.#ok += 1;
    else this.#err += 1;
    this.#cost += record.costUsd;
    this.#in += record.inputTokens;
    this.#out += record.outputTokens;
    this.#cacheRead += record.cacheReadInputTokens;
    this.#cacheCreate += record.cacheCreationInputTokens;
    this.#latency += record.latencyMs;
    if (record.ok && !record.cost.priced) this.#unpriced += 1;
  }

  /**
   * Declare how much active-character wall-clock the folded records cover.
   * Calling repeatedly overwrites (last writer wins) — a scenario sets it once
   * at the end from its own session timer.
   */
  activeMs(ms: number): this {
    this.#activeMs = ms > 0 ? ms : null;
    return this;
  }

  summary(): CostSummary {
    const hours = this.#activeMs == null ? null : this.#activeMs / 3_600_000;
    return {
      calls: this.#calls,
      okCalls: this.#ok,
      errorCalls: this.#err,
      totalCostUsd: this.#cost,
      inputTokens: this.#in,
      outputTokens: this.#out,
      cacheReadInputTokens: this.#cacheRead,
      cacheCreationInputTokens: this.#cacheCreate,
      totalLatencyMs: this.#latency,
      unpricedCalls: this.#unpriced,
      costPerActiveCharHourUsd:
        hours == null || hours === 0 ? null : this.#cost / hours,
    };
  }

  /** Build an aggregator from a jsonl blob (the #585 round-trip). */
  static fromJsonl(jsonl: string): CostAggregator {
    const agg = new CostAggregator();
    for (const line of jsonl.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      agg.add(JSON.parse(trimmed) as TelemetryRecord);
    }
    return agg;
  }
}
