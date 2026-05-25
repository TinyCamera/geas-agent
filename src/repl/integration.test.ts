/**
 * REPL end-to-end against a real Channel-A server in-process (issue #648).
 *
 * - Spins up `createServer` with a `NoopProvider`-driven `IdleSession`,
 *   exactly the harness #667 uses, so this test is the regression net
 *   for wire-format drift across both repos.
 * - Drives `runRepl` with a scripted stdin → captures stdout → strips
 *   ANSI → asserts the transcript.
 * - Drives `hub.emitTelemetry` directly to validate the cost line surface
 *   without wiring a real `TelemetryProvider` (production wiring is a
 *   follow-up sub-issue of #647).
 */

import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { LoopRunner } from '../loop/runner.js';
import { IdleSession } from '../loop/session.js';
import { NoopProvider } from '../llm/noop.js';
import { createStuckDetector } from '../prompts/stuck.js';
import { createRetryBudget } from '../prompts/budget.js';
import { ok, err, makeError, type Result } from '../mcp/errors.js';
import type { GeasToolResponse } from '../mcp/tools.js';
import type { LlmToolDef } from '../llm/provider.js';
import type { AttemptPlan, RecoveryDriver } from '../loop/run-with-retry.js';
import { StaticDevVerifier } from '../server/auth.js';
import { EventHub } from '../server/hub.js';
import { SessionRegistry } from '../server/session-registry.js';
import { createServer, type RunningServer } from '../server/server.js';
import { runRepl } from './cli.js';
import { Transport } from './transport.js';

const TOOLS: readonly LlmToolDef[] = [
  {
    name: 'look',
    description: 'Look around',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const neverRecover: RecoveryDriver = async () => null;

function staticDispatcher(
  responses: ReadonlyArray<Result<GeasToolResponse>>,
): (plan: AttemptPlan) => Promise<Result<GeasToolResponse>> {
  let i = 0;
  return async () => {
    if (i >= responses.length) {
      return err(makeError('unknown_tool', 'dispatcher exhausted'));
    }
    return responses[i++];
  };
}

async function bringUp(): Promise<{
  server: RunningServer;
  port: number;
  hub: EventHub;
}> {
  const hub = new EventHub();
  const verifier = new StaticDevVerifier([['tok-good', 'uid-1']]);
  const registry = new SessionRegistry((uid, characterId) => {
    const emit = hub.emitterFor(uid, characterId);
    return new IdleSession({
      runnerFactory: () => {
        const llm = new NoopProvider({
          script: [
            {
              stopReason: 'tool_use',
              content: [
                { type: 'text', text: 'INTENT: look around' },
                { type: 'tool_use', id: 't1', name: 'look', input: {} },
              ],
            },
            {
              stopReason: 'end_turn',
              content: [{ type: 'text', text: 'You see a torchlit hall.' }],
            },
          ],
        });
        return new LoopRunner({
          llm,
          dispatch: staticDispatcher([
            ok({
              content: [{ type: 'text', text: '{"room":"hall"}' }],
              structuredContent: { room: 'hall' },
            }),
          ]),
          stuckDetector: createStuckDetector(),
          retryBudget: createRetryBudget(),
          recover: neverRecover,
          tools: TOOLS,
          emit,
        });
      },
      emit,
      idleThresholdMs: 50,
    });
  });
  const server = createServer({
    verifier,
    hub,
    registry,
    pingIntervalMs: 0,
  });
  const port = await server.listen(0);
  return { server, port, hub };
}

/** Strip ANSI codes for stable transcript assertions. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

class CaptureStream {
  buffer = '';
  write(s: string): boolean {
    this.buffer += s;
    return true;
  }
}

function scriptedStdin(lines: readonly string[], delayMs = 50): {
  stream: NodeJS.ReadableStream;
  push: (line: string) => void;
  end: () => void;
} {
  const r = new Readable({ read() {} });
  let i = 0;
  const tick = (): void => {
    if (i >= lines.length) return;
    r.push(lines[i] + '\n');
    i += 1;
    setTimeout(tick, delayMs);
  };
  setTimeout(tick, delayMs);
  return {
    stream: r,
    push: (line: string) => r.push(line + '\n'),
    end: () => r.push(null),
  };
}

describe('REPL end-to-end against Channel A', () => {
  it('connects, sends one message, renders the streamed reply', async () => {
    const { server, port, hub } = await bringUp();
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();

    const stdin = scriptedStdin(['Where am I?']);

    const handles = runRepl(
      {
        baseUrl: `http://127.0.0.1:${port}`,
        token: 'tok-good',
        characterId: 'char-1',
        sessionId: 'repl-it-1',
        color: false,
      },
      { stdin: stdin.stream, stdout, stderr },
    );

    try {
      // Wait until we observe a `done` rendered for the turn — `inFlight`
      // flips to false then `prompt()` writes the next prompt. Detect by
      // counting prompt lines in stdout.
      const start = Date.now();
      while (Date.now() - start < 5000) {
        if ((stdout.buffer.match(/^> /gm) ?? []).length >= 2) break;
        await new Promise((r) => setTimeout(r, 25));
      }

      // Drive a telemetry event manually — production wiring is a
      // follow-up; this verifies the wire surface + renderer.
      hub.emitTelemetry('uid-1', 'char-1', {
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        costUsd: 0.0023,
        inputTokens: 172,
        outputTokens: 24,
        cacheReadInputTokens: 38,
        cacheCreationInputTokens: 0,
        latencyMs: 412,
      });

      // Give the WS one tick to deliver telemetry.
      await new Promise((r) => setTimeout(r, 100));

      stdin.end();
      handles.close();
      await handles.done;
    } finally {
      await server.close();
    }

    const plain = stripAnsi(stdout.buffer);
    // Should contain a tool_call line, tool_result line, the narration,
    // and the telemetry cost line.
    expect(plain).toMatch(/→ look\({}\)/);
    expect(plain).toMatch(/← look ok/);
    expect(plain).toContain('You see a torchlit hall.');
    expect(plain).toContain('$0.0023  (172 in / 38 cached / 24 out)');
  }, 10_000);

  it('surfaces a transport error and exits cleanly when the server is gone', async () => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const stdin = scriptedStdin([]);

    const handles = runRepl(
      {
        // Port 1 is reliably closed on macOS/Linux without privileges.
        baseUrl: 'http://127.0.0.1:1',
        token: 'tok',
        characterId: 'c',
        sessionId: 's',
        color: false,
      },
      { stdin: stdin.stream, stdout, stderr },
      // Tighten backoff so the test stays fast.
      (cfg) =>
        new Transport({
          baseUrl: cfg.baseUrl,
          token: cfg.token,
          characterId: cfg.characterId,
          sessionId: cfg.sessionId,
          retryBackoffMs: [10, 20, 30],
        }),
    );

    const code = await handles.done;
    stdin.end();
    expect(code).toBe(1);
    expect(stderr.buffer).toMatch(/disconnected/);
  }, 10_000);
});
