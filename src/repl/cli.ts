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
 *   GEAS_AGENT_TOKEN     required — bearer / WS token
 *   GEAS_AGENT_CHARACTER required — characterId to drive
 */

import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { Transport, type TransportEvent } from './transport.js';
import { renderEvent, renderLines, type RenderPiece } from './render.js';
import {
  applyDecisionInput,
  parsePayload,
  renderInitialPrompt,
  serializeChoice,
  serializeTimeout,
  type DecisionState,
} from './decisions.js';

export interface CliConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly characterId: string;
  readonly sessionId: string;
  readonly color: boolean;
}

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

export function readConfigFromEnv(env: NodeJS.ProcessEnv): CliConfig {
  const baseUrl = env.GEAS_AGENT_URL ?? 'http://127.0.0.1:8090';
  const token = env.GEAS_AGENT_TOKEN ?? '';
  const characterId = env.GEAS_AGENT_CHARACTER ?? '';
  if (!token) {
    throw new Error('GEAS_AGENT_TOKEN is required');
  }
  if (!characterId) {
    throw new Error('GEAS_AGENT_CHARACTER is required');
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
  };
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
  try {
    const config = readConfigFromEnv(process.env);
    const handles = runRepl(config, {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    });
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
