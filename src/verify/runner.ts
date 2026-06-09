/**
 * Verification scenario runner (#673, parent #589).
 *
 * Drives one {@link VerifyScenario} end-to-end:
 *
 *   1. `setup` seeds the {@link VerifyWorld} with a known state.
 *   2. For each scripted turn, mint a fresh {@link LoopRunner} (the loop ends
 *      terminal per turn — same constraint `IdleSession` works around),
 *      seeded with the prior turns' conversation so multi-turn context
 *      carries forward, and drive it with the turn's `userMessage`. Every
 *      Channel-A event the runner emits is collected (for per-turn
 *      `expectedEvents` matching) and appended to a JSONL forensic log.
 *   3. After the script, snapshot the world and run `asserts`.
 *   4. Aggregate token/cost telemetry (via {@link TelemetryProvider} +
 *      {@link CostAggregator}) and retry/tool counts into a {@link
 *      VerifyReport}.
 *
 * **Provider injection.** The caller hands in a fully-constructed
 * `LlmProvider` — `NoopProvider` (deterministic, keyless, driven by the
 * scenario's `noopScript`) or a real vendor provider. The runner wraps it in
 * telemetry and is otherwise provider-agnostic.
 *
 * The runner never throws on a scenario failure: expectation mismatches and
 * `asserts` errors land in `report.failures` with `ok:false`. It only throws
 * on a harness bug (e.g. a world that can't snapshot).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LlmProvider, LlmToolDef } from '../llm/provider.js';
import {
  CostAggregator,
  TelemetryProvider,
  arraySink,
  type TelemetryRecord,
} from '../llm/telemetry.js';
import { LoopRunner, type LoopEmitEvent } from '../loop/runner.js';
import type { LlmMessage } from '../llm/provider.js';
import type { AttemptPlan, RecoveryDriver } from '../loop/run-with-retry.js';
import { createStuckDetector } from '../prompts/stuck.js';
import { createRetryBudget } from '../prompts/budget.js';
import { composeSystemPrompt } from '../prompts/system.js';
import type { GeasMcpClient } from '../mcp/index.js';
import type { GeasToolResponse } from '../mcp/tools.js';
import type { Result } from '../mcp/errors.js';
import type {
  ExpectedEvent,
  VerifyReport,
  VerifyScenario,
  VerifyWorld,
} from './types.js';

/** Recovery driver that never recovers — mirrors `index-server.ts`'s default. */
const NEVER_RECOVER: RecoveryDriver = async () => null;

export interface RunVerifyOptions {
  /** The test geas-server the scenario runs against. */
  readonly world: VerifyWorld;
  /** Provider answering the agent's turns (Noop for CI, real otherwise). */
  readonly provider: LlmProvider;
  /**
   * Directory to write the `<scenario>.jsonl` forensic event log into. When
   * omitted, no file is written (the events still drive expectation matching).
   */
  readonly logDir?: string;
  /** Clock seam for deterministic telemetry timestamps in tests. */
  readonly now?: () => number;
  /** Hard cap on LLM round-trips per turn. Defaults to the runner's own cap. */
  readonly maxTurnsPerMessage?: number;
}

/** Build an MCP dispatcher over a connected client (same shape as prod). */
function buildDispatcher(
  client: GeasMcpClient,
): (plan: AttemptPlan) => Promise<Result<GeasToolResponse>> {
  return (plan) =>
    client.callTool(
      plan.tool as Parameters<GeasMcpClient['callTool']>[0],
      plan.args as Record<string, unknown>,
    );
}

/** Map the MCP tool surface to the model's tool palette (prod parity). */
async function discoverTools(
  client: GeasMcpClient,
): Promise<readonly LlmToolDef[]> {
  const surface = await client.listTools();
  if (!surface.ok) {
    throw new Error(
      `verify: listTools failed: ${surface.error.kind} — ${surface.error.message}`,
    );
  }
  return surface.value
    .filter((t) => !!t.inputSchema)
    .map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema!,
    }));
}

/** Does `event` satisfy `matcher`? */
function eventMatches(event: LoopEmitEvent, matcher: ExpectedEvent): boolean {
  if (event.type !== matcher.type) return false;
  switch (matcher.type) {
    case 'tool-call':
      return (
        event.type === 'tool-call' &&
        (matcher.tool === undefined || event.plan.tool === matcher.tool)
      );
    case 'tool-result':
      return (
        event.type === 'tool-result' &&
        (matcher.tool === undefined || event.tool === matcher.tool) &&
        (matcher.status === undefined || event.outcome.status === matcher.status)
      );
    case 'narration':
      return (
        event.type === 'narration' &&
        (matcher.includes === undefined || event.text.includes(matcher.includes))
      );
    case 'text-delta':
      return (
        event.type === 'text-delta' &&
        (matcher.includes === undefined || event.text.includes(matcher.includes))
      );
    case 'done':
      return event.type === 'done';
    case 'error':
      return (
        event.type === 'error' &&
        (matcher.includes === undefined ||
          event.message.includes(matcher.includes))
      );
  }
}

function describeMatcher(m: ExpectedEvent): string {
  const extra: string[] = [];
  if ('tool' in m && m.tool) extra.push(`tool=${m.tool}`);
  if ('status' in m && m.status) extra.push(`status=${m.status}`);
  if ('includes' in m && m.includes) extra.push(`includes=${JSON.stringify(m.includes)}`);
  return extra.length ? `${m.type}(${extra.join(',')})` : m.type;
}

/** Run a single verification scenario, producing a {@link VerifyReport}. */
export async function runVerifyScenario(
  scenario: VerifyScenario,
  opts: RunVerifyOptions,
): Promise<VerifyReport> {
  const startedAt = Date.now();
  const failures: string[] = [];

  // Telemetry: one record per LLM call → cost/token aggregation.
  const records: TelemetryRecord[] = [];
  const provider = new TelemetryProvider({
    inner: opts.provider,
    sink: arraySink(records),
    ...(opts.now ? { now: opts.now } : {}),
  });

  const { world } = opts;
  const tools = await discoverTools(world.client);
  const system = [{ type: 'text' as const, text: composeSystemPrompt('') }];
  const dispatch = buildDispatcher(world.client);

  // JSONL forensic log lines (event stream + turn markers).
  const logLines: string[] = [];
  const log = (obj: Record<string, unknown>): void => {
    logLines.push(JSON.stringify({ ts: new Date().toISOString(), ...obj }));
  };
  log({ kind: 'scenario-start', scenario: scenario.name, world: world.kind });

  // ---- setup ----
  await scenario.setup(world);
  log({ kind: 'setup-complete', snapshot: await world.snapshot() });

  // ---- drive the script ----
  let priorMessages: readonly LlmMessage[] = [];
  let toolCalls = 0;
  let retries = 0;

  for (let i = 0; i < scenario.script.length; i++) {
    const turn = scenario.script[i];
    const events: LoopEmitEvent[] = [];

    const runner = new LoopRunner({
      llm: provider,
      dispatch,
      stuckDetector: createStuckDetector(),
      retryBudget: createRetryBudget(),
      recover: NEVER_RECOVER,
      tools,
      system,
      emit: (event) => {
        events.push(event);
        log({ kind: 'event', turn: i, event });
      },
      ...(opts.maxTurnsPerMessage !== undefined
        ? { maxTurns: opts.maxTurnsPerMessage }
        : {}),
    });
    if (priorMessages.length > 0) runner.seedMessages(priorMessages);

    log({ kind: 'user-message', turn: i, text: turn.userMessage });
    await runner.start(turn.userMessage);
    priorMessages = [...runner.messages];

    // Tally tool usage from this turn's events.
    for (const e of events) {
      if (e.type === 'tool-call') toolCalls += 1;
      if (e.type === 'tool-result') {
        retries += Math.max(0, e.outcome.attempts - 1);
      }
    }

    // Per-turn expectation matching.
    for (const matcher of turn.expectedEvents ?? []) {
      const hit = events.some((e) => eventMatches(e, matcher));
      if (!hit) {
        failures.push(
          `turn ${i} ("${turn.userMessage}"): expected event ${describeMatcher(
            matcher,
          )} not emitted`,
        );
      }
    }
  }

  // ---- asserts ----
  const snapshot = await world.snapshot();
  log({ kind: 'asserts-start', snapshot });
  try {
    await scenario.asserts({ world, snapshot });
  } catch (e) {
    failures.push(`asserts: ${(e as Error).message}`);
  }

  // ---- aggregate ----
  const agg = new CostAggregator();
  for (const r of records) agg.add(r);
  const summary = agg.summary();
  const totalTokens =
    summary.inputTokens +
    summary.outputTokens +
    summary.cacheReadInputTokens +
    summary.cacheCreationInputTokens;

  const ok = failures.length === 0;
  const durationMs = Date.now() - startedAt;
  log({ kind: 'scenario-end', scenario: scenario.name, ok, durationMs, failures });

  // ---- forensic log ----
  let logPath: string | undefined;
  if (opts.logDir) {
    mkdirSync(opts.logDir, { recursive: true });
    logPath = join(opts.logDir, `${scenario.name}.jsonl`);
    writeFileSync(logPath, logLines.join('\n') + '\n', 'utf8');
  }

  return {
    scenario: scenario.name,
    ok,
    turns: summary.calls,
    userTurns: scenario.script.length,
    totalTokens,
    totalCostUsd: summary.totalCostUsd,
    retries,
    toolCalls,
    durationMs,
    failures,
    ...(logPath ? { logPath } : {}),
  };
}
