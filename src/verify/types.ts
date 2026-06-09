/**
 * Verification harness types (#673, parent #589).
 *
 * The verification harness boots a geas-agent, connects it to a geas-server,
 * and drives the agent through scripted *verification scenarios* using a real
 * (or scripted) LLM provider, then asserts on the resulting server state. It
 * is the agent-side analogue of the `kipp` playtester: where `kipp` is an
 * interactive opus session, this is a deterministic, CI-runnable harness.
 *
 * **How it differs from `src/scenarios/`.** A `Scenario` (see
 * `src/scenarios/types.ts`) is a closed-form TS function that calls MCP tools
 * directly — no LLM in the loop. A {@link VerifyScenario} drives the *real
 * agent loop*: the LLM decides which tools to call from a natural-language
 * user message. Verification scenarios therefore prove the whole stack
 * (prompt → model → tool dispatch → server mutation), not just the MCP
 * wrapper.
 *
 * **Provider-agnostic by construction.** A scenario describes *what the user
 * says* and *what must be true afterwards*; it does not hard-code which
 * provider answers. The harness injects the provider:
 *
 *   - `NoopProvider` (default, CI): each scenario supplies a {@link
 *     VerifyScenario.noopScript} so the run is deterministic and keyless.
 *   - A real provider (Anthropic / Gemini) when keys are present: the
 *     `noopScript` is ignored and the model decides for itself.
 *
 * The {@link VerifyReport} captures cost so the cost-regression assertion
 * (#675) can read it without re-running.
 */

import type { ScriptedTurn } from '../llm/noop.js';
import type { GeasMcpClient } from '../mcp/index.js';

/**
 * A minimal, structured view of the character's world state — the slice
 * scenarios assert on. Both the in-memory fake world and a live geas-server
 * project onto this shape so the same scenario runs against either.
 */
export interface WorldSnapshot {
  /** Current hit points, when known. */
  readonly hp?: number;
  /** Maximum hit points, when known. */
  readonly maxHp?: number;
  /** World-tile position, when known. */
  readonly position?: { readonly x: number; readonly y: number };
  /** Character level, when known. */
  readonly level?: number;
  /** Anything else the world exposes — scenarios read by key. */
  readonly [k: string]: unknown;
}

/** Mutable fields a scenario's `setup` may seed before the agent runs. */
export interface WorldSeed {
  readonly hp?: number;
  readonly maxHp?: number;
  readonly position?: { readonly x: number; readonly y: number };
  readonly level?: number;
  readonly [k: string]: unknown;
}

/**
 * The test geas-server a scenario runs against. The harness owns construction
 * and teardown; the scenario only reads/seeds through this handle.
 */
export interface VerifyWorld {
  /** Human label for reports/logs (`fake` / `live:<url>`). */
  readonly kind: string;
  /** The connected MCP client the agent dispatches tool calls through. */
  readonly client: GeasMcpClient;
  /**
   * Seed/override world state before the script runs. The in-memory fake
   * mutates its state directly; a live world makes a best-effort attempt via
   * MCP dev tools and may warn when a field can't be seeded.
   */
  seed(patch: WorldSeed): Promise<void>;
  /** Snapshot the current world state for `asserts`. */
  snapshot(): Promise<WorldSnapshot>;
  /** Tear down (disconnect client; close the fake server). Idempotent. */
  close(): Promise<void>;
}

/**
 * One matcher asserted against the Channel-A events a single turn emitted.
 * A turn passes its `expectedEvents` iff every matcher finds a matching event.
 */
export type ExpectedEvent =
  | { readonly type: 'tool-call'; readonly tool?: string }
  | { readonly type: 'tool-result'; readonly tool?: string; readonly status?: string }
  | { readonly type: 'narration'; readonly includes?: string }
  | { readonly type: 'text-delta'; readonly includes?: string }
  | { readonly type: 'done' }
  | { readonly type: 'error'; readonly includes?: string };

/** One turn of a verification script: a user message + per-turn expectations. */
export interface VerifyTurn {
  /** What the user says to the agent this turn. */
  readonly userMessage: string;
  /** Channel-A events that must appear while driving this turn. Optional. */
  readonly expectedEvents?: readonly ExpectedEvent[];
}

/**
 * Context handed to `asserts` after the script completes. Carries the world
 * (for state reads) and the run's aggregated report-so-far (for cost / retry
 * assertions a scenario wants to make inline).
 */
export interface VerifyAssertContext {
  readonly world: VerifyWorld;
  readonly snapshot: WorldSnapshot;
}

/**
 * A verification scenario: seed a known world, drive the agent through a
 * scripted conversation, assert on the resulting server state.
 */
export interface VerifyScenario {
  readonly name: string;
  readonly description: string;
  /**
   * LLM turns replayed when the harness runs with the {@link
   * '../llm/noop.js'.NoopProvider}. Each entry is one model round-trip
   * (tool-use or text). Ignored when a real provider is injected. Omit for
   * scenarios that only make sense against a real model.
   */
  readonly noopScript?: readonly ScriptedTurn[];
  /** Seed the world before the script runs. */
  setup(world: VerifyWorld): Promise<void>;
  /** Turn-by-turn conversation driving the agent. */
  readonly script: readonly VerifyTurn[];
  /** Assert on the final world state. Throw to fail. */
  asserts(ctx: VerifyAssertContext): Promise<void>;
}

/** The per-scenario result the runner produces. */
export interface VerifyReport {
  readonly scenario: string;
  /** True iff every turn's expectations held and `asserts` did not throw. */
  readonly ok: boolean;
  /** Total LLM round-trips across all turns. */
  readonly turns: number;
  /** Number of user messages driven (script length). */
  readonly userTurns: number;
  /** Total tokens billed (input + output + cache buckets). */
  readonly totalTokens: number;
  /** Total USD cost across the run. */
  readonly totalCostUsd: number;
  /** Total tool retries (sum of `attempts - 1` over tool calls). */
  readonly retries: number;
  /** Number of tool calls dispatched. */
  readonly toolCalls: number;
  /** Wall-clock for the scenario, ms. */
  readonly durationMs: number;
  /** Human-readable failure descriptions (empty iff `ok`). */
  readonly failures: readonly string[];
  /** Path to the JSONL forensic event log, when one was written. */
  readonly logPath?: string;
}
