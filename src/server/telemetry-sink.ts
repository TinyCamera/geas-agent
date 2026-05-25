/**
 * Producer-side wiring for Channel-A telemetry events (#725, parent #647).
 *
 * `wire.ts` (the `TelemetryEvent` shape) and `EventHub.emitTelemetry(...)` were
 * shipped in #648 as the wire surface so the REPL renderer + tests could land
 * before the producer existed. This module is the producer-side counterpart:
 * a per-`(uid, characterId)` {@link TelemetrySink} that takes a
 * {@link TelemetryRecord} (born inside {@link TelemetryProvider}) and pumps the
 * subset clients care about onto the hub.
 *
 * **Why a separate sink, not a method on the hub.** `TelemetryProvider` accepts
 * any `(record) => void` sink (jsonl, array, summary aggregator …). Binding the
 * hub call site inside a small adapter keeps `TelemetryProvider` ignorant of
 * Channel A — it stays usable for scenarios / benchmarks / future transports —
 * and keeps `EventHub` ignorant of `TelemetryRecord`'s `cost` / `ts` /
 * `errorKind` fields that the wire event deliberately drops.
 *
 * **Tag convention.** `TelemetryProvider` already supports a free-form `tag`
 * string. We always set it to `${uid}:${characterId}` so a downstream jsonl
 * (e.g. {@link jsonlSink}) gives `$/active-character-hour` per-character
 * without re-deriving identity from anywhere else. Matches `streamKey` in
 * `hub.ts` for trivial join-ability.
 *
 * **Best-effort, never throws.** The underlying `TelemetryProvider` swallows
 * sink errors so a transient hub blip cannot poison the agent loop. We mirror
 * that stance here — `try`/`catch` around `emitTelemetry` even though the hub
 * already isolates per-subscriber errors.
 */

import {
  TelemetryProvider,
  type TelemetryRecord,
  type TelemetrySink,
} from '../llm/telemetry.js';
import type { LlmProvider } from '../llm/provider.js';
import type { EventHub } from './hub.js';

/** Stamp used for `TelemetryProvider.tag`. Public so callers can rebuild it. */
export function telemetryTag(uid: string, characterId: string): string {
  return `${uid}:${characterId}`;
}

/**
 * Build a {@link TelemetrySink} that projects every {@link TelemetryRecord} it
 * receives into a Channel-A `telemetry` event on `hub` for `(uid, characterId)`.
 *
 * The projection drops `ts` (the hub stamps its own server clock), `mode`,
 * `ok`, `errorKind`, and the per-bucket `cost` split — clients only render the
 * fields {@link TelemetryEvent} carries (provider, model, costUsd, the four
 * token buckets, latencyMs). Dropped fields stay available in the jsonl /
 * `CostAggregator` paths.
 */
export function createTelemetrySink(
  hub: EventHub,
  uid: string,
  characterId: string,
): TelemetrySink {
  return (record: TelemetryRecord) => {
    try {
      hub.emitTelemetry(uid, characterId, {
        provider: record.provider,
        model: record.model,
        costUsd: record.costUsd,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        cacheReadInputTokens: record.cacheReadInputTokens,
        cacheCreationInputTokens: record.cacheCreationInputTokens,
        latencyMs: record.latencyMs,
      });
    } catch {
      // Telemetry is observability, not control flow — never fail the call.
    }
  };
}

/**
 * Convenience: wrap `inner` in a {@link TelemetryProvider} whose records flow
 * onto `hub` as Channel-A `telemetry` events for `(uid, characterId)`. The
 * `TelemetryProvider.tag` is set to `${uid}:${characterId}` per #725's design
 * note ("so cross-character cost analysis stays trivial").
 *
 * Use this at `SessionFactory` construction time so each `IdleSession`'s
 * `LoopRunner` is built with a telemetry-instrumented LLM without the factory
 * caller having to know about `TelemetryProvider` at all.
 */
export function wrapLlmWithTelemetry(
  inner: LlmProvider,
  hub: EventHub,
  uid: string,
  characterId: string,
): TelemetryProvider {
  return new TelemetryProvider({
    inner,
    sink: createTelemetrySink(hub, uid, characterId),
    tag: telemetryTag(uid, characterId),
  });
}
