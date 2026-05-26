/**
 * REPL entry point (issue #648).
 *
 * `npm run repl` boots this. Connects to a locally-running geas-agent
 * Channel-A server, reads stdin line-by-line, sends each line as a chat
 * message, and renders streamed events to stdout via `render.ts`.
 *
 * **One outstanding turn at a time.** We don't re-prompt until the
 * server emits `done` for the current turn — otherwise output would
 * interleave with the next prompt line. The transport guarantees one
 * `done` per chat (the runner's `done` event). If the WS dies mid-turn
 * the reconnect path replays buffered events, including the missing
 * `done`, so we don't hang.
 *
 * **Out of scope here.** Interactive decision prompts are #649; session
 * resume across reboots is #650; rich TUI (panels, scrollback) was
 * explicitly cut.
 *
 * **Config.** Reads from env so neither flags nor a config file are
 * needed for the smoke test:
 *   GEAS_AGENT_URL       default http://127.0.0.1:8090
 *   GEAS_AGENT_TOKEN     default "dev-token" (matches StaticDevVerifier in
 *                        the agent server; ONLY suitable for local dev — a
 *                        startup warning is printed when the default is used)
 *   GEAS_AGENT_CHARACTER required for chat sessions; can be sidestepped by
 *                        running `--new-character` to mint one and use it,
 *                        or `--list` to see existing sessions.
 *   GEAS_MCP_URL         default http://localhost:8088/mcp (only consulted by
 *                        `--new-character`, which calls the geas-server MCP
 *                        endpoint directly to mint a character).
 */

import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { GeasMcpClient } from '../mcp/client.js';
import { Transport, fetchSessions, type TransportEvent } from './transport.js';
import { renderEvent, renderLines, type RenderPiece } from './render.js';
import {
  applyDecisionInput,
  parsePayload,
  renderInitialPrompt,
  serializeChoice,
  serializeTimeout,
  type DecisionState,
} from './decisions.js';
import { parseArgs, USAGE } from './args.js';
import { renderListing } from './listing.js';

export interface CliConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly characterId: string;
  readonly sessionId: string;
  readonly color: boolean;
  /**
   * True when `GEAS_AGENT_TOKEN` was unset and we defaulted to `dev-token`.
   * The caller prints a one-line warning on session start so dev-mode use
   * is visible — production callers MUST set the env var.
   */
  readonly tokenIsDefault: boolean;
}

/** Default token: matches `StaticDevVerifier(['dev-token', GEAS_DEV_UID])`. */
export const DEFAULT_AGENT_TOKEN = 'dev-token';

/** Default name when `--new-character` is invoked with no name argument. */
export const DEFAULT_NEW_CHARACTER_NAME = 'repl-user';

/**
 * Help-text body printed when `GEAS_AGENT_CHARACTER` is missing. Exposed so
 * a unit test can snapshot exactly what a first-run user sees.
 */
export const MISSING_CHARACTER_HELP = `repl: GEAS_AGENT_CHARACTER is required.

  Set one of:
    export GEAS_AGENT_CHARACTER=<your-character-id>
    npm run repl -- --list             # see existing sessions
    npm run repl -- --new-character    # create a fresh character and use it

  See docs/dev.md → "Try the REPL" for the full local-dev runbook.
`;

/**
 * Help-text body printed when the REPL can't reach the agent server. Exposed
 * so the same hint shows up consistently regardless of which call failed.
 */
export const UNREACHABLE_SERVER_HELP = `repl: could not reach the geas-agent server.

  Check that:
    - 'npm run dev:server' is running in another terminal
    - GEAS_AGENT_PORT (server) and GEAS_AGENT_URL (this REPL) point at
      the same port (defaults: server 8090, REPL http://127.0.0.1:8090)

  See docs/dev.md → "Try the REPL" for the full local-dev runbook.
`;

export interface CliIo {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: { write(s: string): boolean | unknown };
  readonly stderr: { write(s: string): boolean | unknown };
}

export interface CliHandles {
  /** Resolves when the REPL exits cleanly. */
  readonly done: Promise<number>;
  /** External shutdown — Ctrl-C handler, tests, etc. */
  close(): void;
}

export function readConfigFromEnv(
  env: NodeJS.ProcessEnv,
  opts: { readonly requireCharacter?: boolean } = {},
): CliConfig {
  const requireCharacter = opts.requireCharacter ?? true;
  const baseUrl = env.GEAS_AGENT_URL ?? 'http://127.0.0.1:8090';
  const tokenFromEnv = env.GEAS_AGENT_TOKEN;
  const tokenIsDefault = !tokenFromEnv;
  const token = tokenFromEnv ?? DEFAULT_AGENT_TOKEN;
  const characterId = env.GEAS_AGENT_CHARACTER ?? '';
  if (requireCharacter && !characterId) {
    throw new Error(MISSING_CHARACTER_HELP);
  }
  // Disable colour in non-TTY (piped tests, CI). NO_COLOR overrides.
  const isTty = !!(process.stdout as NodeJS.WriteStream).isTTY;
  const color = !env.NO_COLOR && isTty;
  return {
    baseUrl,
    token,
    characterId,
    sessionId: env.GEAS_AGENT_SESSION ?? `repl-${randomUUID()}`,
    color,
    tokenIsDefault,
  };
}

/**
 * `--list` flow: hit `GET /sessions`, render the table to stdout, exit 0.
 * Errors render to stderr and resolve a non-zero exit code.
 *
 * Returns the exit code the caller should propagate.
 */
export async function runList(
  env: NodeJS.ProcessEnv,
  io: CliIo,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const baseUrl = env.GEAS_AGENT_URL ?? 'http://127.0.0.1:8090';
  const tokenFromEnv = env.GEAS_AGENT_TOKEN;
  const token = tokenFromEnv ?? DEFAULT_AGENT_TOKEN;
  if (!tokenFromEnv) {
    io.stderr.write(
      `[GEAS_AGENT_TOKEN unset — using default "${DEFAULT_AGENT_TOKEN}" (dev-only)]\n`,
    );
  }
  try {
    const res = await fetchSessions({ baseUrl, token, fetchImpl });
    const lines = renderListing(res.sessions);
    for (const l of lines) io.stdout.write(l + '\n');
    return 0;
  } catch (e) {
    io.stderr.write(`repl: ${(e as Error).message}\n`);
    io.stderr.write(UNREACHABLE_SERVER_HELP);
    return 1;
  }
}

/**
 * Pull a `characterId` out of a `create_character` MCP response. The server's
 * payload shape has drifted across releases — we look in the obvious places
 * (`structuredContent.characterId`, `structuredContent.id`, then any
 * `text`-typed content blob with a JSON object carrying the same keys).
 *
 * Returns null when we can't find one — caller renders a fail-fast error
 * pointing the user at the raw payload rather than guessing.
 */
export function extractCharacterId(
  response: { structuredContent?: Record<string, unknown>; content?: Array<{ type: string; text?: string }> },
): string | null {
  const sc = response.structuredContent ?? {};
  for (const k of ['characterId', 'id', 'character_id'] as const) {
    const v = sc[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  // Some `create_character` responses wrap the new character under a nested
  // `character` / `result` key (e.g. `{ character: { id, name, ... } }`).
  for (const wrap of ['character', 'result'] as const) {
    const w = sc[wrap];
    if (w && typeof w === 'object') {
      const o = w as Record<string, unknown>;
      for (const k of ['characterId', 'id', 'character_id'] as const) {
        const v = o[k];
        if (typeof v === 'string' && v.length > 0) return v;
      }
    }
  }
  // Last resort: scan `text` content blocks for a JSON-shaped id.
  for (const c of response.content ?? []) {
    if (c.type !== 'text' || !c.text) continue;
    try {
      const parsed = JSON.parse(c.text) as Record<string, unknown>;
      for (const k of ['characterId', 'id', 'character_id'] as const) {
        const v = parsed[k];
        if (typeof v === 'string' && v.length > 0) return v;
      }
    } catch {
      // not JSON; ignore
    }
  }
  return null;
}

/**
 * `--new-character` flow: connect directly to geas-server MCP, mint a fresh
 * character, print its id, then hand back the id so the REPL can start a
 * session against it.
 *
 * Tests inject `mcpFactory` so we don't need a live MCP endpoint. Production
 * uses the default factory which builds a real `GeasMcpClient` pointed at
 * `GEAS_MCP_URL`.
 */
export async function mintCharacter(
  env: NodeJS.ProcessEnv,
  io: CliIo,
  name: string,
  mcpFactory?: (opts: { url: string; devUid: string; bearerToken?: string }) => GeasMcpClient,
): Promise<string | null> {
  const mcpUrl = env.GEAS_MCP_URL ?? 'http://localhost:8088/mcp';
  const devUid = env.GEAS_DEV_UID ?? 'nick-dev';
  const bearer = env.GEAS_BEARER_TOKEN;
  const make = mcpFactory ?? ((o) => new GeasMcpClient(o));
  const client = make({ url: mcpUrl, devUid, ...(bearer ? { bearerToken: bearer } : {}) });
  const conn = await client.connect();
  if (!conn.ok) {
    io.stderr.write(
      `repl: MCP connect failed (${mcpUrl}): ${conn.error.kind} — ${conn.error.message}\n`,
    );
    io.stderr.write(UNREACHABLE_SERVER_HELP);
    return null;
  }
  try {
    const res = await client.callTool('create_character', { name });
    if (!res.ok) {
      io.stderr.write(
        `repl: create_character failed: ${res.error.kind} — ${res.error.message}\n`,
      );
      return null;
    }
    const id = extractCharacterId(res.value);
    if (!id) {
      io.stderr.write(
        'repl: create_character succeeded but no characterId in response. Raw payload:\n',
      );
      io.stderr.write(JSON.stringify(res.value).slice(0, 2000) + '\n');
      return null;
    }
    // Recognisable line so users can grep / copy it.
    io.stdout.write(`GEAS_AGENT_CHARACTER=${id}\n`);
    io.stderr.write(
      `[created character "${name}" id=${id} via ${mcpUrl} as ${devUid}]\n`,
    );
    return id;
  } finally {
    await client.disconnect().catch(() => {
      // ignore — we're exiting either way if the REPL throws below.
    });
  }
}

/**
 * Run the REPL. Returns a handle the caller can use to shut it down
 * (Ctrl-C handler, test teardown) and an exit-code promise.
 */
export function runRepl(
  config: CliConfig,
  io: CliIo,
  transportFactory?: (cfg: CliConfig) => Transport,
): CliHandles {
  const make = transportFactory ?? ((c) =>
    new Transport({
      baseUrl: c.baseUrl,
      token: c.token,
      characterId: c.characterId,
      sessionId: c.sessionId,
    }));
  const transport = make(config);
  const rl = createInterface({ input: io.stdin, terminal: false });

  let inFlight = false;
  let midText = false;
  let exitCode = 0;
  let seenConnect = false;
  let pendingDecision: DecisionState | null = null;
  let decisionTimer: NodeJS.Timeout | null = null;

  function clearDecisionTimer(): void {
    if (decisionTimer) {
      clearTimeout(decisionTimer);
      decisionTimer = null;
    }
  }

  function resolveDecision(decisionId: string, text: string): void {
    clearDecisionTimer();
    pendingDecision = null;
    transport.resolveDecision(decisionId, text).catch((err) => {
      writeErr(`[resolve-decision failed: ${(err as Error).message}]\n`);
    });
  }
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((r) => {
    resolveDone = r;
  });

  function writeOut(s: string): void {
    io.stdout.write(s);
  }
  function writeErr(s: string): void {
    io.stderr.write(s);
  }

  function flushPieces(pieces: readonly RenderPiece[]): void {
    for (const p of pieces) {
      if (p.kind === 'inline') {
        writeOut(p.text);
        midText = true;
      } else if (p.kind === 'line') {
        if (midText) {
          writeOut('\n');
          midText = false;
        }
        writeOut(p.text + '\n');
      } else {
        // turn-end
        if (midText) {
          writeOut('\n');
          midText = false;
        }
      }
    }
  }

  function prompt(): void {
    if (config.color) {
      writeOut('\x1b[1m> \x1b[0m');
    } else {
      writeOut('> ');
    }
  }

  transport.on((ev: TransportEvent) => {
    switch (ev.type) {
      case 'connected':
        seenConnect = true;
        // Print the sessionId on its own line first so the user can copy
        // it for a later `--session <id>` invocation. Stays on stderr so
        // piping the REPL's stdout still yields clean chat content.
        writeErr(`[session ${config.sessionId}]\n`);
        if (config.tokenIsDefault) {
          writeErr(
            `[GEAS_AGENT_TOKEN unset — using default "${DEFAULT_AGENT_TOKEN}" (dev-only)]\n`,
          );
        }
        writeErr(
          `[connected to ${config.baseUrl} as ${config.characterId}` +
            (ev.resumeCursor ? ` resume=${ev.resumeCursor}` : '') +
            ']\n',
        );
        prompt();
        return;
      case 'reconnecting':
        writeErr(`[reconnecting attempt ${ev.attempt} in ${ev.delayMs}ms]\n`);
        return;
      case 'disconnected':
        writeErr(`[disconnected: ${ev.reason}]\n`);
        // If we never made it past the initial connect, surface the env-var
        // hint — the most common cause is the agent server not running or
        // the GEAS_AGENT_URL / GEAS_AGENT_PORT pair mismatched.
        if (!seenConnect) {
          writeErr(UNREACHABLE_SERVER_HELP);
        }
        exitCode = 1;
        cleanup();
        return;
      case 'event': {
        if (ev.event.type === 'decision') {
          // Render the prompt + start tracking the active decision so the
          // next stdin line is routed into `applyDecisionInput` instead of
          // `transport.send`.
          const decisionEv = ev.event;
          const { lines, state } = renderInitialPrompt(
            decisionEv.decisionId,
            decisionEv.payload,
          );
          flushPieces(renderLines(lines, { color: config.color }));
          pendingDecision = state;
          const parsed = parsePayload(decisionEv.payload);
          clearDecisionTimer();
          if (parsed.deadlineMs && parsed.deadlineMs > 0) {
            decisionTimer = setTimeout(() => {
              if (pendingDecision && pendingDecision.decisionId === decisionEv.decisionId) {
                writeErr(`[decision ${decisionEv.decisionId} timed out]\n`);
                resolveDecision(decisionEv.decisionId, serializeTimeout());
              }
            }, parsed.deadlineMs);
          }
          return;
        }
        const pieces = renderEvent(ev.event, { color: config.color });
        flushPieces(pieces);
        if (ev.event.type === 'done') {
          inFlight = false;
          prompt();
        }
        return;
      }
    }
  });

  rl.on('line', (raw) => {
    const line = raw.trim();
    if (line === ':quit' || line === ':q') {
      cleanup();
      return;
    }
    if (pendingDecision) {
      const result = applyDecisionInput(pendingDecision, raw);
      switch (result.kind) {
        case 'select': {
          const id = pendingDecision.decisionId;
          resolveDecision(id, serializeChoice({ optionId: result.optionId }));
          return;
        }
        case 'stat-progress': {
          pendingDecision = result.nextState;
          flushPieces(renderLines(result.lines, { color: config.color }));
          return;
        }
        case 'cancel': {
          const id = pendingDecision.decisionId;
          clearDecisionTimer();
          pendingDecision = null;
          transport
            .resolveDecision(id, JSON.stringify({ cancelled: true }))
            .catch((err) => {
              writeErr(`[resolve-decision failed: ${(err as Error).message}]\n`);
            });
          return;
        }
        case 'invalid': {
          flushPieces(renderLines(result.lines, { color: config.color }));
          return;
        }
      }
      return;
    }
    if (!line) {
      prompt();
      return;
    }
    if (inFlight) {
      writeErr('[turn in flight — waiting for done]\n');
      return;
    }
    inFlight = true;
    transport.send(line).catch((err) => {
      writeErr(`[send failed: ${(err as Error).message}]\n`);
      inFlight = false;
      prompt();
    });
  });

  rl.on('close', () => {
    cleanup();
  });

  let cleanedUp = false;
  function cleanup(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    clearDecisionTimer();
    try {
      rl.close();
    } catch {
      // ignore
    }
    transport.close();
    if (midText) {
      writeOut('\n');
      midText = false;
    }
    resolveDone(exitCode);
  }

  // Fire the connect — errors surface as 'disconnected' on the listener.
  transport.connect().catch(() => {
    // 'disconnected' event will resolve `done`.
  });

  return {
    done,
    close: cleanup,
  };
}

// CLI entrypoint — only when run directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  const io: CliIo = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };

  if (parsed.mode === 'help') {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (parsed.mode === 'error') {
    process.stderr.write(`repl: ${parsed.message}\n${USAGE}`);
    process.exit(2);
  }
  if (parsed.mode === 'list') {
    runList(process.env, io).then((code) => process.exit(code));
  } else if (parsed.mode === 'new-character') {
    (async () => {
      const name = parsed.name ?? DEFAULT_NEW_CHARACTER_NAME;
      const id = await mintCharacter(process.env, io, name);
      if (!id) {
        process.exit(2);
      }
      try {
        // `mintCharacter` already verified MCP reachability; now boot the
        // REPL against the freshly-minted character. Inject the id into the
        // env so `readConfigFromEnv` picks it up like any other run.
        const env = { ...process.env, GEAS_AGENT_CHARACTER: id };
        const base = readConfigFromEnv(env);
        const handles = runRepl(base, io);
        process.on('SIGINT', () => {
          process.stderr.write('\n[SIGINT — closing]\n');
          handles.close();
        });
        handles.done.then((code) => process.exit(code));
      } catch (e) {
        process.stderr.write(`repl: ${(e as Error).message}\n`);
        process.exit(2);
      }
    })();
  } else {
    try {
      const base = readConfigFromEnv(process.env);
      const config: CliConfig =
        parsed.mode === 'resume'
          ? { ...base, sessionId: parsed.sessionId }
          : base;
      const handles = runRepl(config, io);
      process.on('SIGINT', () => {
        process.stderr.write('\n[SIGINT — closing]\n');
        handles.close();
      });
      handles.done.then((code) => process.exit(code));
    } catch (e) {
      process.stderr.write(`repl: ${(e as Error).message}\n`);
      process.exit(2);
    }
  }
}
