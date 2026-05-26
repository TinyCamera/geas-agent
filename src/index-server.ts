/**
 * geas-agent production server entrypoint (#730).
 *
 * Boots Channel A with a real `SessionFactory` so a user can run
 * `npm run dev:server` + `npm run repl` in two terminals and have a working
 * terminal-driven LLM agent end-to-end. This is the milestone-completion
 * smoke surface Niall scoped on 2026-05-21:
 *
 *   "agent complete and running locally, terminal interface, no GUI client."
 *
 * Everything *under* the milestone shipped previously (the entire #586 retry
 * layer, all of #587 agent loop, the #647 REPL client). This file is the
 * small wiring that ties them together with real Anthropic + real MCP +
 * conversation persistence + Channel-A telemetry.
 *
 * **Env contract.** All read from `process.env`. Fail-fast on missing
 * `ANTHROPIC_API_KEY` — every other variable defaults sensibly:
 *
 * | Var                       | Default                       | Purpose                                  |
 * |---------------------------|-------------------------------|------------------------------------------|
 * | `ANTHROPIC_API_KEY`       | (required)                    | LLM provider auth                        |
 * | `GEAS_MCP_URL`            | `http://localhost:8088/mcp`   | MCP endpoint                             |
 * | `GEAS_DEV_UID`            | `nick-dev`                    | Static dev verifier UID — matches the    |
 * |                           |                               | geas-server local stack default so       |
 * |                           |                               | characters created there are visible to  |
 * |                           |                               | the agent without any extra env wiring.  |
 * | `GEAS_AGENT_PORT`         | `8090`                        | Channel-A listen port — aligned with the |
 * |                           |                               | REPL's `GEAS_AGENT_URL` default so the   |
 * |                           |                               | client talks to something out of the box.|
 * | `FIRESTORE_EMULATOR_HOST` | (unset → in-memory store)     | Switches conversation store to Firestore |
 * | `GEAS_BEARER_TOKEN`       | (unset → relies on dev unauth) | MCP bearer token for prod                |
 *
 * **What the factory wires per session.**
 *
 *   1. `AnthropicProvider` (haiku-4-5 default) wrapped in `TelemetryProvider`
 *      tagged `${uid}:${characterId}` (per #725's contract). Telemetry records
 *      project onto Channel A so the REPL renders per-turn cost lines.
 *   2. A real `GeasMcpClient` pointed at `GEAS_MCP_URL`. The MCP tool surface
 *      is discovered via `listTools()` at boot — we don't hand-roll the
 *      `LlmToolDef[]` here, we let the server be the source of truth.
 *   3. `InMemoryConversationStore` by default; `FirestoreConversationStore`
 *      when `FIRESTORE_EMULATOR_HOST` is set. Same `ConversationStore`
 *      contract for both so swap is invisible to the runner.
 *   4. `seedRunnerFromSession` invoked at runner construction iff a prior
 *      session exists for `(uid, characterId)` — we resume the most recent
 *      one. Greenfield characters seed nothing.
 *
 * **What this entrypoint is NOT.**
 *
 *   - Not multi-user OAuth — that's #588, still `needs-niall`. We use
 *     `StaticDevVerifier(GEAS_DEV_UID)` for the milestone.
 *   - Not Cloud Run deploy — that's #590. We bind to `GEAS_AGENT_PORT` on
 *     all interfaces. No structured JSON logging, no readiness checks
 *     beyond `GET /healthz` (already in `server.ts`).
 *   - **Persistence.** As of #732 each completed turn is written via
 *     `ConversationStore.appendTurn(...)` so cross-restart `--session <id>`
 *     resume actually has prior turns to seed from. The factory holds a
 *     per-session monotonic turn-index counter primed from the store; the
 *     runner appends one doc at terminal state. Decision-wake turns
 *     (Channel-B push without a transport-supplied sessionId) skip
 *     persistence — they're out of scope until the wire-up lands.
 */

import process from 'node:process';

import { AnthropicProvider } from './llm/anthropic.js';
import { GeminiProvider } from './llm/gemini.js';
import { type LlmProvider, type LlmToolDef } from './llm/provider.js';
import { GeasMcpClient } from './mcp/index.js';
import { type GeasToolResponse } from './mcp/tools.js';
import { type Result } from './mcp/errors.js';
import { LoopRunner } from './loop/runner.js';
import { IdleSession } from './loop/session.js';
import { seedRunnerFromSession } from './loop/resume.js';
import type { AttemptPlan, RecoveryDriver } from './loop/run-with-retry.js';
import { createStuckDetector } from './prompts/stuck.js';
import { createRetryBudget } from './prompts/budget.js';
import { composeSystemPrompt } from './prompts/system.js';
import {
  InMemoryConversationStore,
  type ConversationStore,
} from './persistence/conversation-store.js';
import { FirestoreConversationStore } from './persistence/firestore-conversation-store.js';
import { initFirestore } from './persistence/firestore.js';
import { StaticDevVerifier } from './server/auth.js';
import { EventHub } from './server/hub.js';
import { SessionRegistry } from './server/session-registry.js';
import { createServer, type RunningServer } from './server/server.js';
import { wrapLlmWithTelemetry } from './server/telemetry-sink.js';

/**
 * Which LLM backend to boot. `anthropic` (default, Haiku 4.5) and `gemini`
 * (Flash 2.5) are interchangeable through {@link LlmProvider}; selection is
 * boot-time only (no per-conversation switching). Added #734 after Niall
 * surfaced the gap going to try the REPL with no Anthropic key on the box.
 */
export type LlmProviderName = 'anthropic' | 'gemini';

/** Resolved server-boot config (testable seam — separate from `process.env`). */
export interface ServerBootConfig {
  readonly mcpUrl: string;
  readonly devUid: string;
  readonly port: number;
  readonly anthropicApiKey: string | null;
  /** Gemini API key — only consulted when `llmProvider === 'gemini'`. */
  readonly geminiApiKey: string | null;
  /** Which LLM provider to boot. Defaults to `anthropic`. */
  readonly llmProvider: LlmProviderName;
  readonly bearerToken?: string;
  readonly useFirestore: boolean;
  /**
   * Wait budget for `POST /chat/sync` (#736). Default 120_000 ms. Lifted
   * from `SYNC_CHAT_TIMEOUT_MS` in `process.env`. Tests can pin a tight
   * value via the bootstrap config to exercise 504s.
   */
  readonly syncChatTimeoutMs?: number;
  /**
   * Force the LLM provider regardless of `anthropicApiKey`. Tests pass a
   * `NoopProvider` here so the entrypoint boots without an Anthropic key.
   * Production callers (the `main()` path below) never set this — the key
   * gate fires instead.
   */
  readonly llmOverride?: LlmProvider;
  /**
   * Pre-built (and pre-connected) MCP client. Tests pass an in-memory-linked
   * client; production goes through `bootServer` which builds the real
   * `GeasMcpClient` from `cfg.mcpUrl`. When set, `bootServer` will NOT call
   * `connect()` — the override is assumed live.
   */
  readonly mcpOverride?: GeasMcpClient;
}

/** Parse env into a typed config. Pure — does NOT touch `process.exit`. */
export function readBootConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ServerBootConfig {
  const port = env.GEAS_AGENT_PORT
    ? Number.parseInt(env.GEAS_AGENT_PORT, 10)
    : 8090;
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(
      `GEAS_AGENT_PORT must be a positive integer, got ${env.GEAS_AGENT_PORT}`,
    );
  }
  let syncChatTimeoutMs: number | undefined;
  if (env.SYNC_CHAT_TIMEOUT_MS) {
    const n = Number.parseInt(env.SYNC_CHAT_TIMEOUT_MS, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(
        `SYNC_CHAT_TIMEOUT_MS must be a positive integer, got ${env.SYNC_CHAT_TIMEOUT_MS}`,
      );
    }
    syncChatTimeoutMs = n;
  }
  const rawProvider = (env.GEAS_AGENT_LLM_PROVIDER ?? 'anthropic')
    .trim()
    .toLowerCase();
  if (rawProvider !== 'anthropic' && rawProvider !== 'gemini') {
    throw new Error(
      `GEAS_AGENT_LLM_PROVIDER must be 'anthropic' or 'gemini', got '${env.GEAS_AGENT_LLM_PROVIDER}'`,
    );
  }
  return {
    mcpUrl: env.GEAS_MCP_URL ?? 'http://localhost:8088/mcp',
    devUid: env.GEAS_DEV_UID ?? 'nick-dev',
    port,
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? null,
    geminiApiKey: env.GOOGLE_GEMINI_API_KEY ?? null,
    llmProvider: rawProvider as LlmProviderName,
    bearerToken: env.GEAS_BEARER_TOKEN,
    useFirestore: !!env.FIRESTORE_EMULATOR_HOST,
    ...(syncChatTimeoutMs !== undefined ? { syncChatTimeoutMs } : {}),
  };
}

/** Buffer-emitting MCP dispatcher: `AttemptPlan → Result<GeasToolResponse>`. */
function buildDispatcher(
  client: GeasMcpClient,
): (plan: AttemptPlan) => Promise<Result<GeasToolResponse>> {
  return async (plan) => {
    // The MCP client validates args + handles transport; we just forward.
    return client.callTool(
      plan.tool as Parameters<GeasMcpClient['callTool']>[0],
      plan.args as Record<string, unknown>,
    );
  };
}

/**
 * Best-effort no-op recovery driver. The retry layer still owns budget +
 * stuck detection; without an LLM-backed recovery driver the loop just
 * retries until the budget is exhausted. An LLM-driven recovery driver is
 * out of scope for #730 — the milestone is "boots end-to-end", not
 * "production-grade recovery". Filed as a follow-up.
 */
const NEVER_RECOVER: RecoveryDriver = async () => null;

/**
 * Build the concrete {@link LlmProvider} per `cfg.llmProvider`. Fails fast
 * on a missing key — reaching either branch with a `null` key is a caller
 * bug, since `main()` validates the keys before calling `bootServer`. Tests
 * skip this entirely by passing `llmOverride`.
 */
function buildProvider(cfg: ServerBootConfig): LlmProvider {
  if (cfg.llmProvider === 'gemini') {
    if (!cfg.geminiApiKey) {
      throw new Error(
        "bootServer: GEAS_AGENT_LLM_PROVIDER='gemini' requires GOOGLE_GEMINI_API_KEY (or pass llmOverride)",
      );
    }
    return new GeminiProvider({ apiKey: cfg.geminiApiKey });
  }
  // anthropic (default)
  if (!cfg.anthropicApiKey) {
    throw new Error(
      'bootServer: ANTHROPIC_API_KEY missing and no llmOverride supplied',
    );
  }
  return new AnthropicProvider({ apiKey: cfg.anthropicApiKey });
}

/** Convert MCP tool surface → LLM tool defs (the model's tool palette). */
function toLlmToolDefs(
  surface: ReadonlyArray<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>,
): readonly LlmToolDef[] {
  return surface
    .filter((t) => !!t.inputSchema)
    .map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema!,
    }));
}

/** What `bootServer` returns — kept tiny so tests can teardown cleanly. */
export interface BootedServer {
  readonly server: RunningServer;
  readonly port: number;
  readonly hub: EventHub;
  readonly registry: SessionRegistry;
  readonly mcp: GeasMcpClient;
  readonly store: ConversationStore;
  close(): Promise<void>;
}

/**
 * Boot the geas-agent server end-to-end. Exported so the integration test
 * can drive the full wiring with a `NoopProvider` (no real Anthropic key
 * needed in CI), and so the `main()` entrypoint stays a thin
 * config-read → boot shell.
 */
export async function bootServer(cfg: ServerBootConfig): Promise<BootedServer> {
  // ---- MCP client (shared across sessions; one process = one MCP socket) ----
  let mcp: GeasMcpClient;
  if (cfg.mcpOverride) {
    mcp = cfg.mcpOverride;
  } else {
    mcp = new GeasMcpClient({
      url: cfg.mcpUrl,
      devUid: cfg.devUid,
      bearerToken: cfg.bearerToken,
      onWarning: (msg, detail) =>
        console.warn(`[geas-agent][mcp] ${msg}`, detail ?? ''),
    });
    const conn = await mcp.connect();
    if (!conn.ok) {
      throw new Error(
        `MCP connect failed (${cfg.mcpUrl}): ${conn.error.kind} — ${conn.error.message}`,
      );
    }
  }
  const surface = await mcp.listTools();
  if (!surface.ok) {
    throw new Error(
      `MCP listTools failed: ${surface.error.kind} — ${surface.error.message}`,
    );
  }
  const tools = toLlmToolDefs(surface.value);

  // ---- Conversation store ----
  const store: ConversationStore = cfg.useFirestore
    ? new FirestoreConversationStore(initFirestore())
    : new InMemoryConversationStore();

  // ---- LLM provider (constructed once; wrapped per session for telemetry) ----
  // The wrap is what carries the per-character `${uid}:${characterId}` tag,
  // so a single underlying AnthropicProvider is safe to share.
  const baseProvider: LlmProvider =
    cfg.llmOverride ?? buildProvider(cfg);

  // ---- Server-side primitives ----
  const hub = new EventHub();
  const verifier = new StaticDevVerifier([['dev-token', cfg.devUid]]);
  const systemPrompt = composeSystemPrompt('');

  const registry = new SessionRegistry((uid, characterId) => {
    const emit = hub.emitterFor(uid, characterId);
    const llmForThisSession = wrapLlmWithTelemetry(
      baseProvider,
      hub,
      uid,
      characterId,
    );
    // Per-session monotonic turn-index counters. First call primes from
    // the store so a resumed session continues numbering after the
    // already-persisted turns; subsequent calls bump in-memory.
    const turnCounters = new Map<string, Promise<number>>();
    const nextIndexFor = (sessionId: string): Promise<number> => {
      const prev = turnCounters.get(sessionId);
      const next = (async () => {
        if (prev !== undefined) return (await prev) + 1;
        const existing = await store.getSessionTurns(
          { uid, characterId },
          sessionId,
        );
        // First write into this session: index = count of already-persisted.
        return existing.length;
      })();
      turnCounters.set(sessionId, next);
      return next;
    };

    return new IdleSession({
      emit,
      runnerFactory: (ctx) => {
        const runner = new LoopRunner({
          llm: llmForThisSession,
          dispatch: buildDispatcher(mcp),
          stuckDetector: createStuckDetector(),
          retryBudget: createRetryBudget(),
          recover: NEVER_RECOVER,
          tools,
          system: [{ type: 'text', text: systemPrompt }],
          emit,
          // Wire persistence iff the transport handed us a sessionId.
          // Decision-wake (Channel-B push) currently has no sessionId
          // and skips persistence — out of scope here.
          ...(ctx?.sessionId
            ? {
                persistence: {
                  store,
                  key: { uid, characterId },
                  sessionId: ctx.sessionId,
                  displayName: ctx.displayName ?? characterId,
                  nextTurnIndex: () => nextIndexFor(ctx.sessionId!),
                },
              }
            : {}),
        });
        // Resume from the most recent prior session, if any. Greenfield
        // characters get an empty buffer. Resume is fire-and-forget on
        // session-factory invocation: by the time the user's first message
        // lands the seed promise will have completed (the user typing in
        // the REPL is many ms slower than a Firestore read). On the
        // off-chance it hasn't, the runner just starts with an empty
        // buffer for that turn — degrade-not-fail.
        if (ctx?.sessionId) {
          // Seed from the specified session (cross-restart resume).
          void seedRunnerFromSession({
            runner,
            store,
            key: { uid, characterId },
            sessionId: ctx.sessionId,
          });
        } else {
          // Fallback: best-effort latest-session seed (legacy behaviour).
          void resumeLatestSession({ store, uid, characterId, runner });
        }
        return runner;
      },
    });
  });

  // ---- Wire up the HTTP/WS server ----
  const server = createServer({
    verifier,
    registry,
    hub,
    store,
    ...(cfg.syncChatTimeoutMs !== undefined
      ? { syncChatTimeoutMs: cfg.syncChatTimeoutMs }
      : {}),
  });
  const boundPort = await server.listen(cfg.port);

  return {
    server,
    port: boundPort,
    hub,
    registry,
    mcp,
    store,
    async close() {
      await registry.closeAll();
      await server.close();
      await mcp.disconnect();
    },
  };
}

async function resumeLatestSession(input: {
  readonly store: ConversationStore;
  readonly uid: string;
  readonly characterId: string;
  readonly runner: LoopRunner;
}): Promise<void> {
  try {
    const sessions = await input.store.listSessions(input.uid);
    const forChar = sessions.filter(
      (s) => s.characterId === input.characterId,
    );
    if (forChar.length === 0) return;
    // Most recent by `lastActive` ISO string — lexical sort works.
    forChar.sort((a, b) => (a.lastActive < b.lastActive ? 1 : -1));
    const latest = forChar[0];
    await seedRunnerFromSession({
      runner: input.runner,
      store: input.store,
      key: { uid: input.uid, characterId: input.characterId },
      sessionId: latest.sessionId,
    });
  } catch (e) {
    console.warn(
      `[geas-agent] resume failed for ${input.uid}:${input.characterId}:`,
      (e as Error).message,
    );
  }
}

/** Process entrypoint. */
export async function main(): Promise<void> {
  const cfg = readBootConfigFromEnv();
  if (cfg.llmProvider === 'anthropic' && !cfg.anthropicApiKey) {
    process.stderr.write(
      '[geas-agent] ANTHROPIC_API_KEY is required. ' +
        'Set it in your shell (export ANTHROPIC_API_KEY=sk-...) and retry, ' +
        "or switch backends with GEAS_AGENT_LLM_PROVIDER=gemini + GOOGLE_GEMINI_API_KEY.\n",
    );
    process.exit(2);
  }
  if (cfg.llmProvider === 'gemini' && !cfg.geminiApiKey) {
    process.stderr.write(
      '[geas-agent] GOOGLE_GEMINI_API_KEY is required when ' +
        "GEAS_AGENT_LLM_PROVIDER='gemini'. Set it in your shell " +
        '(export GOOGLE_GEMINI_API_KEY=...) and retry.\n',
    );
    process.exit(2);
  }
  const booted = await bootServer(cfg);
  // The `model=` tag lets the REPL user see at a glance which backend
  // they're talking to — important during the #585 provider-shake-out.
  const modelLabel =
    cfg.llmProvider === 'gemini' ? 'gemini-2.5-flash' : 'claude-haiku-4-5';
  console.log(
    `[geas-agent] READY mcp=${cfg.mcpUrl} uid=${cfg.devUid} port=${booted.port} ` +
      `provider=${cfg.llmProvider} model=${modelLabel} ` +
      `store=${cfg.useFirestore ? 'firestore' : 'memory'}`,
  );
  const shutdown = async (sig: string) => {
    console.log(`[geas-agent] received ${sig}, shutting down`);
    try {
      await booted.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('[geas-agent] fatal:', e);
    process.exit(1);
  });
}
