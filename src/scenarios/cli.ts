/**
 * Scenario CLI — `npm run scenario:<name>` entry point.
 *
 * Reads config from env, boots a `GeasMcpClient`, ensures we have a character
 * (creating a fresh one if the soul is empty), constructs an `AgentBinding`,
 * runs the scenario, and exits with a code that reflects the outcome.
 *
 * Env:
 *   GEAS_MCP_URL          — required, e.g. http://localhost:8088/mcp
 *   GEAS_DEV_UID          — informational; mirrors server's GEAS_DEV_UID
 *   GEAS_BEARER_TOKEN     — prod auth; ignored when GEAS_DEV_UNAUTH on server
 *   GEAS_SCENARIO_CHAR    — optional character name to create when no active
 *                           character exists (default: scenario-<scenarioName>)
 *   GEAS_SCENARIO_TIMEOUT — optional wall-clock budget in seconds (default 120)
 *
 * Exit codes:
 *   0 — scenario ran to completion (including benign early returns)
 *   1 — scenario function threw, or unknown scenario name
 *   2 — environment / connection failure (couldn't reach server, auth, etc.)
 *   3 — bad invocation (no scenario name argument)
 */

import process from 'node:process';

import { GeasMcpClient } from '../mcp/index.js';
import { createBinding, type AgentBinding } from '../binding/index.js';
import { createScenarioRegistry } from './registry.js';
import { runScenario } from './runner.js';
import { createConsoleLogger } from './logger.js';
import { structured, unwrap } from './util.js';

const DEFAULT_TIMEOUT_S = 120;

export interface CliOptions {
  scenarioName: string;
  url: string;
  devUid: string;
  bearerToken?: string;
  characterName?: string;
  timeoutMs: number;
}

/**
 * Parse argv (`[scenarioName]`) + env. Exported so tests can exercise parsing
 * without touching `process.exit`.
 */
export function parseCliOptions(
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): { ok: true; options: CliOptions } | { ok: false; message: string; exitCode: number } {
  const name = argv[0];
  if (!name) {
    return {
      ok: false,
      exitCode: 3,
      message: 'usage: scenario-cli <scenario-name>\n(or run the npm script: `npm run scenario:<scenario-name>`)',
    };
  }
  const url = env.GEAS_MCP_URL;
  if (!url) {
    return {
      ok: false,
      exitCode: 2,
      message: 'GEAS_MCP_URL is required (e.g. http://localhost:8088/mcp)',
    };
  }
  const devUid = env.GEAS_DEV_UID ?? 'scenario-runner';
  const timeoutS = env.GEAS_SCENARIO_TIMEOUT
    ? Number.parseInt(env.GEAS_SCENARIO_TIMEOUT, 10)
    : DEFAULT_TIMEOUT_S;
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
    return {
      ok: false,
      exitCode: 3,
      message: `GEAS_SCENARIO_TIMEOUT must be a positive integer seconds, got ${env.GEAS_SCENARIO_TIMEOUT}`,
    };
  }
  return {
    ok: true,
    options: {
      scenarioName: name,
      url,
      devUid,
      bearerToken: env.GEAS_BEARER_TOKEN,
      characterName: env.GEAS_SCENARIO_CHAR,
      timeoutMs: timeoutS * 1000,
    },
  };
}

interface WhoamiShape {
  activePlayerId?: string | null;
  active?: { playerId?: string; name?: string } | null;
  sessionId?: string | null;
}

/**
 * Resolve a character to bind to. Reuses the active character if the soul has
 * one (keeps reruns idempotent — no character spam), otherwise creates a new
 * one named after the scenario. Returns the binding ready to wire into a fresh
 * client (since the binding is constructor-time on `GeasMcpClient`, we
 * `disconnect` the bootstrap client and the caller builds a second one for the
 * scenario run).
 */
export async function resolveBinding(
  client: GeasMcpClient,
  opts: { devUid: string; scenarioName: string; characterName?: string },
): Promise<AgentBinding> {
  const whoamiResp = unwrap('whoami', await client.whoami());
  const w = structured<WhoamiShape>(whoamiResp) ?? {};
  let playerId = w.activePlayerId ?? w.active?.playerId ?? null;
  if (!playerId) {
    const fallbackName =
      opts.characterName ?? `scenario-${opts.scenarioName}-${shortStamp()}`;
    const createResp = unwrap(
      'create_character',
      await client.createCharacter({ name: fallbackName }),
    );
    const created = structured<{ playerId?: string; name?: string }>(createResp);
    playerId = created?.playerId ?? null;
    if (!playerId) {
      throw new Error('create_character returned no playerId');
    }
  }
  return createBinding({
    entityId: playerId,
    ownerUid: opts.devUid,
    bindingMode: 'agent-only',
  });
}

function shortStamp(): string {
  return Math.floor(Date.now() / 1000).toString(36);
}

/**
 * Full CLI orchestration. Pure async — does not call `process.exit`. The
 * top-level `if (import.meta.url === ...)` block below maps the return code to
 * an exit. This split keeps the function reachable from a "run-as-test"
 * harness (which we don't have yet but #582's body explicitly calls out as a
 * deterministic test surface).
 */
export async function main(
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const parsed = parseCliOptions(argv, env);
  if (!parsed.ok) {
    console.error(parsed.message);
    return parsed.exitCode;
  }
  const opts = parsed.options;
  const logger = createConsoleLogger(`[scenario:${opts.scenarioName}]`);
  const registry = createScenarioRegistry();
  if (!registry.has(opts.scenarioName)) {
    console.error(
      `unknown scenario "${opts.scenarioName}"; known: ${[...registry.keys()].join(', ') || '(none)'}`,
    );
    return 1;
  }

  // -- bootstrap client (no binding yet) — used only to resolve identity. ---
  const bootstrap = new GeasMcpClient({
    url: opts.url,
    devUid: opts.devUid,
    bearerToken: opts.bearerToken,
    clientName: 'geas-agent-scenario-runner',
  });
  const connect = await bootstrap.connect();
  if (!connect.ok) {
    console.error(
      `failed to connect to ${opts.url}: ${connect.error.kind} — ${connect.error.message}`,
    );
    await bootstrap.disconnect();
    return 2;
  }

  let binding: AgentBinding;
  try {
    binding = await resolveBinding(bootstrap, {
      devUid: opts.devUid,
      scenarioName: opts.scenarioName,
      characterName: opts.characterName,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`failed to resolve character binding: ${msg}`);
    await bootstrap.disconnect();
    return 2;
  }
  await bootstrap.disconnect();
  logger.info(
    `bound to entity=${binding.entityId} owner=${binding.ownerUid} mode=${binding.bindingMode}`,
  );

  // -- real run client carrying the binding. --------------------------------
  const runClient = new GeasMcpClient({
    url: opts.url,
    devUid: opts.devUid,
    bearerToken: opts.bearerToken,
    binding,
    clientName: 'geas-agent-scenario-runner',
  });
  const runConnect = await runClient.connect();
  if (!runConnect.ok) {
    console.error(
      `failed to reconnect with binding: ${runConnect.error.kind} — ${runConnect.error.message}`,
    );
    await runClient.disconnect();
    return 2;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    logger.error(`scenario exceeded ${opts.timeoutMs}ms budget; aborting`);
    controller.abort();
  }, opts.timeoutMs);

  try {
    const result = await runScenario(opts.scenarioName, registry, {
      client: runClient,
      binding,
      logger,
      signal: controller.signal,
    });
    return result.ok ? 0 : 1;
  } finally {
    clearTimeout(timer);
    await runClient.disconnect();
  }
}

// CLI entry — invoked via `npm run scenario:<name>`.
const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (err) => {
      console.error('scenario runner crashed:', err);
      process.exit(2);
    },
  );
}
