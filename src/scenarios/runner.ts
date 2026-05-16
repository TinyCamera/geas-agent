/**
 * Scenario runner — looks up a registered scenario by name, builds the context
 * (already-constructed client + binding), runs it, returns a structured
 * `RunResult` the CLI can turn into an exit code.
 *
 * **Why the runner does not construct the client itself.** Wiring the client
 * from env, registering a binding, and creating a character are all separate
 * concerns from "execute the scenario function" — separating them keeps the
 * runner trivially unit-testable with an in-memory client (`tests/` and
 * `runner.test.ts` both do exactly that). The CLI module owns the env-to-client
 * boot path and hands the runner the result.
 */

import type { GeasMcpClient } from '../mcp/index.js';
import type { AgentBinding } from '../binding/index.js';
import type { ScenarioLogger, ScenarioRegistration } from './types.js';
import { createConsoleLogger } from './logger.js';

export interface RunScenarioOptions {
  client: GeasMcpClient;
  binding: AgentBinding;
  logger?: ScenarioLogger;
  signal?: AbortSignal;
}

export interface RunResult {
  ok: boolean;
  scenario: string;
  durationMs: number;
  error?: { message: string; cause?: unknown };
}

export class ScenarioNotFoundError extends Error {
  constructor(name: string, known: string[]) {
    super(
      `unknown scenario "${name}". Known scenarios: ${known.length === 0 ? '(none registered)' : known.join(', ')}`,
    );
    this.name = 'ScenarioNotFoundError';
  }
}

/**
 * Run the named scenario from the registry. Returns `{ok: false, error}` for
 * controlled failure paths (scenario threw, lookup miss); throws only for
 * genuinely-broken inputs (missing client). The CLI translates `ok=false` →
 * exit 1 with a clear stderr message.
 */
export async function runScenario(
  name: string,
  registry: ReadonlyMap<string, ScenarioRegistration>,
  options: RunScenarioOptions,
): Promise<RunResult> {
  if (!options.client) {
    throw new Error('runScenario: `client` is required');
  }
  if (!options.binding) {
    throw new Error('runScenario: `binding` is required');
  }
  const entry = registry.get(name);
  if (!entry) {
    const err = new ScenarioNotFoundError(name, [...registry.keys()]);
    return {
      ok: false,
      scenario: name,
      durationMs: 0,
      error: { message: err.message, cause: err },
    };
  }
  const logger = options.logger ?? createConsoleLogger(`[scenario:${name}]`);
  const started = Date.now();
  logger.info(`starting "${entry.description}"`);
  try {
    await entry.run({
      client: options.client,
      binding: options.binding,
      logger,
      signal: options.signal,
    });
    const durationMs = Date.now() - started;
    logger.info(`completed in ${durationMs}ms`);
    return { ok: true, scenario: name, durationMs };
  } catch (e) {
    const durationMs = Date.now() - started;
    const message = e instanceof Error ? e.message : String(e);
    logger.error(`failed after ${durationMs}ms: ${message}`, e);
    return {
      ok: false,
      scenario: name,
      durationMs,
      error: { message, cause: e },
    };
  }
}
