/**
 * `npm run test:verify` — the verification harness CLI (#673).
 *
 * Runs the registered {@link VerifyScenario}s and prints a per-scenario
 * pass/fail report with cost. Exit code is non-zero iff any scenario failed,
 * so it drops straight into CI (#676).
 *
 * **Two modes, selected by env.**
 *
 *   - *Default (deterministic, keyless).* No `GEAS_LIVE_MCP_URL` set → each
 *     scenario runs against an in-memory stateful fake geas-server driven by a
 *     `NoopProvider` replaying the scenario's `noopScript`. This is the CI
 *     self-test: no API key, no network, no cost.
 *
 *   - *Live (real LLM + real server).* `GEAS_LIVE_MCP_URL` set → scenarios run
 *     against that geas-server with a real provider (`GEAS_AGENT_LLM_PROVIDER`,
 *     default `anthropic`), the "end-to-end with a real LLM" acceptance leg.
 *     Requires the matching API key.
 *
 * Usage:
 *   npm run test:verify                 # all scenarios, fake+noop
 *   npm run test:verify -- smoke        # one scenario by name
 *   npm run test:verify -- --list       # list scenarios and exit
 */

import process from 'node:process';
import { join } from 'node:path';

import { AnthropicProvider } from '../llm/anthropic.js';
import { GeminiProvider } from '../llm/gemini.js';
import { NoopProvider } from '../llm/noop.js';
import type { LlmProvider } from '../llm/provider.js';
import { createFakeWorld } from './fake-world.js';
import { createLiveWorld } from './live-world.js';
import { formatReport, formatRun } from './report.js';
import { runVerifyScenario } from './runner.js';
import { VERIFY_SCENARIOS, createVerifyRegistry } from './scenarios/index.js';
import type { VerifyReport, VerifyScenario, VerifyWorld } from './types.js';

interface CliOptions {
  readonly names: string[];
  readonly list: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const names: string[] = [];
  let list = false;
  for (const a of argv) {
    if (a === '--list' || a === '-l') list = true;
    else if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
    else names.push(a);
  }
  return { names, list };
}

/** Build the real provider for live runs. Throws on a missing key. */
function buildLiveProvider(env: NodeJS.ProcessEnv): LlmProvider {
  const name = (env.GEAS_AGENT_LLM_PROVIDER ?? 'anthropic').trim().toLowerCase();
  if (name === 'gemini') {
    const key = env.GOOGLE_GEMINI_API_KEY;
    if (!key) {
      throw new Error(
        "test:verify live mode with GEAS_AGENT_LLM_PROVIDER='gemini' needs GOOGLE_GEMINI_API_KEY",
      );
    }
    return new GeminiProvider({ apiKey: key });
  }
  if (name !== 'anthropic') {
    throw new Error(`unknown GEAS_AGENT_LLM_PROVIDER '${name}'`);
  }
  const key = env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error('test:verify live mode needs ANTHROPIC_API_KEY');
  }
  return new AnthropicProvider({ apiKey: key });
}

async function buildWorld(
  env: NodeJS.ProcessEnv,
  liveUrl: string | undefined,
): Promise<VerifyWorld> {
  if (liveUrl) {
    return createLiveWorld({
      url: liveUrl,
      ...(env.GEAS_LIVE_DEV_UID ? { devUid: env.GEAS_LIVE_DEV_UID } : {}),
      ...(env.GEAS_BEARER_TOKEN ? { bearerToken: env.GEAS_BEARER_TOKEN } : {}),
    });
  }
  return createFakeWorld();
}

function providerFor(
  scenario: VerifyScenario,
  liveUrl: string | undefined,
  env: NodeJS.ProcessEnv,
): LlmProvider {
  if (liveUrl) return buildLiveProvider(env);
  return new NoopProvider({ script: scenario.noopScript ?? [] });
}

export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const opts = parseArgs(argv);
  const registry = createVerifyRegistry();

  if (opts.list) {
    for (const s of VERIFY_SCENARIOS) {
      process.stdout.write(`${s.name}\t${s.description}\n`);
    }
    return 0;
  }

  const selected: VerifyScenario[] =
    opts.names.length > 0
      ? opts.names.map((n) => {
          const s = registry.get(n);
          if (!s) throw new Error(`unknown scenario: ${n}`);
          return s;
        })
      : [...VERIFY_SCENARIOS];

  const liveUrl = env.GEAS_LIVE_MCP_URL;
  const logDir =
    env.GEAS_VERIFY_LOG_DIR ?? join('verify', 'runs', String(Date.now()));

  process.stdout.write(
    `[verify] ${selected.length} scenario(s) — ` +
      `mode=${liveUrl ? `live(${liveUrl})` : 'fake+noop'} log=${logDir}\n\n`,
  );

  const reports: VerifyReport[] = [];
  for (const scenario of selected) {
    const world = await buildWorld(env, liveUrl);
    try {
      const report = await runVerifyScenario(scenario, {
        world,
        provider: providerFor(scenario, liveUrl, env),
        logDir,
      });
      reports.push(report);
      process.stdout.write(formatReport(report) + '\n\n');
    } finally {
      await world.close();
    }
  }

  process.stdout.write(formatRun(reports) + '\n');
  return reports.every((r) => r.ok) ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('[verify] fatal:', e);
      process.exit(1);
    });
}
