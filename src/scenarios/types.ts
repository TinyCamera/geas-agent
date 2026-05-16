/**
 * Scenario types — the shared shape for hand-written, deterministic agent
 * behaviours used to smoke-test the harness end-to-end.
 *
 * **Why "scenarios" instead of "agents".** A scenario is a closed-form TS
 * function: no LLM, no retry, no stuck detection. Scenarios are the
 * deterministic counterpart to the real agent loop (LLM-driven, lives in later
 * epics). They exist so we can:
 *
 *   1. Prove the wrapper + binding + server enforcement actually work end-to-end
 *      against a real geas-server without paying for model calls.
 *   2. Serve as regression smoke-tests for the harness — when the MCP surface
 *      drifts or `act` intents change shape, scenarios break loudly.
 *   3. Document the expected call patterns (find target → close → attack →
 *      retreat) in executable form for the eventual LLM prompt designer to
 *      compare against.
 *
 * **Logger is injected, not console-locked.** The CLI uses a console logger; the
 * unit tests use a buffer logger so we can assert on log lines without spying
 * on globals. Same reason the scenario function takes the client + binding +
 * logger as plain arguments — they're trivially mockable.
 *
 * **Scenarios return void; failure modes are thrown errors.** The wrapper's
 * `Result<T>` ergonomics are great inside a single tool call, but a multi-step
 * scenario reads much better as straight-line code with `throw` on
 * unrecoverable problems and explicit early `return` on benign exits (target
 * killed, HP threshold hit). The runner catches and surfaces those.
 */

import type { GeasMcpClient } from '../mcp/index.js';
import type { AgentBinding } from '../binding/index.js';

export interface ScenarioLogger {
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export interface ScenarioContext {
  client: GeasMcpClient;
  binding: AgentBinding;
  logger: ScenarioLogger;
  /** Optional cancellation channel — runner threads its own AbortController in. */
  signal?: AbortSignal;
}

export type Scenario = (ctx: ScenarioContext) => Promise<void>;

export interface ScenarioRegistration {
  name: string;
  description: string;
  run: Scenario;
}
