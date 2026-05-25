/**
 * REPL end-to-end decision round-trip (issue #649).
 *
 * Spins up the real Channel-A server with a stub session that **only**
 * records `deliverDecision` calls. Pushes each of the three known decision
 * kinds onto the wire (level_up, build_picker, character_creation) plus
 * an unknown-kind fallback, drives the REPL with scripted stdin, and
 * asserts the resolve-decision payload that came back through
 * `POST /resolve-decision`.
 */

import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { StaticDevVerifier } from '../server/auth.js';
import { EventHub } from '../server/hub.js';
import { SessionRegistry } from '../server/session-registry.js';
import { createServer, type RunningServer } from '../server/server.js';
import type { IdleSession } from '../loop/session.js';
import { runRepl } from './cli.js';

/**
 * Minimal IdleSession-shaped stub. The server only reaches into
 * `deliverUserMessage`, `deliverDecision`, and `close`. Everything else
 * is unused by these tests, so we cast to `IdleSession` deliberately —
 * the alternative is wiring a full LoopRunner per case which adds zero
 * coverage for the decision round-trip path under test here.
 */
interface RecorderSession {
  readonly delivered: { decisionId: string; text: string }[];
  readonly deliverUserMessage: (text: string) => Promise<void>;
  readonly deliverDecision: (decisionId: string, text: unknown) => void;
  readonly close: () => Promise<void>;
}

function makeRecorder(): RecorderSession {
  const delivered: { decisionId: string; text: string }[] = [];
  return {
    delivered,
    deliverUserMessage: async () => {},
    deliverDecision: (decisionId, text) => {
      delivered.push({ decisionId, text: String(text) });
    },
    close: async () => {},
  };
}

class CaptureStream {
  buffer = '';
  write(s: string): boolean {
    this.buffer += s;
    return true;
  }
}

interface ScriptedStdin {
  readonly stream: NodeJS.ReadableStream;
  push(line: string): void;
  end(): void;
}

function scriptedStdin(): ScriptedStdin {
  const r = new Readable({ read() {} });
  return {
    stream: r,
    push: (line: string) => r.push(line + '\n'),
    end: () => r.push(null),
  };
}

interface Harness {
  server: RunningServer;
  port: number;
  hub: EventHub;
  recorder: RecorderSession;
}

async function bringUp(): Promise<Harness> {
  const hub = new EventHub();
  const verifier = new StaticDevVerifier([['tok', 'uid-1']]);
  const recorder = makeRecorder();
  const registry = new SessionRegistry(
    () => recorder as unknown as IdleSession,
  );
  const server = createServer({
    verifier,
    hub,
    registry,
    pingIntervalMs: 0,
  });
  const port = await server.listen(0);
  return { server, port, hub, recorder };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 4000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor: timed out');
}

async function runCase(
  decisionId: string,
  payload: unknown,
  scriptedLines: readonly string[],
): Promise<{ delivered: RecorderSession['delivered']; transcript: string }> {
  const { server, port, hub, recorder } = await bringUp();
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const stdin = scriptedStdin();

  const handles = runRepl(
    {
      baseUrl: `http://127.0.0.1:${port}`,
      token: 'tok',
      characterId: 'char-1',
      sessionId: 's1',
      color: false,
    },
    { stdin: stdin.stream, stdout, stderr },
  );

  try {
    // Wait until WS is connected.
    await waitFor(() => /connected to/.test(stderr.buffer));
    // Pre-register the session so /resolve-decision's `peek` finds it.
    await fetch(`http://127.0.0.1:${port}/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer tok',
      },
      body: JSON.stringify({
        sessionId: 's1',
        characterId: 'char-1',
        message: 'hi',
      }),
    });
    // Push the decision event.
    const emit = hub.emitterFor('uid-1', 'char-1');
    emit({ type: 'decision', decisionId, payload });
    // Wait until the prompt header has rendered to stdout — this proves
    // the WS delivered the decision and `pendingDecision` is now set.
    await waitFor(() =>
      /Pick \d|Character creation|Choose your build|\(no options/.test(stdout.buffer),
    );
    // Now feed the scripted lines, with a tiny gap between them so
    // multi-step flows (character_creation) re-render between inputs.
    for (const line of scriptedLines) {
      stdin.push(line);
      await new Promise((r) => setTimeout(r, 50));
    }
    // Wait for delivered.
    await waitFor(() => recorder.delivered.length > 0, 4000);
  } finally {
    handles.close();
    await handles.done;
    await server.close();
  }
  return { delivered: recorder.delivered, transcript: stdout.buffer };
}

describe('REPL decision round-trip', () => {
  it('level_up: numbered prompt, user picks 1, optionId arrives at session', async () => {
    const { delivered, transcript } = await runCase(
      'd-lvl',
      {
        kind: 'level_up',
        options: [
          { id: 'power-strike', label: 'Power Strike', description: 'STR +2' },
          { id: 'block', label: 'Block' },
        ],
      },
      ['1'],
    );
    expect(transcript).toContain('Level up — pick one:');
    expect(transcript).toContain('[1] Power Strike — STR +2');
    expect(delivered).toEqual([{ decisionId: 'd-lvl', text: 'power-strike' }]);
  }, 10_000);

  it('build_picker: user picks 2, second optionId arrives', async () => {
    const { delivered, transcript } = await runCase(
      'd-build',
      {
        kind: 'build_picker',
        options: [
          { id: 'warrior', label: 'Warrior' },
          { id: 'mage', label: 'Mage' },
        ],
      },
      ['2'],
    );
    expect(transcript).toContain('Choose your build:');
    expect(delivered).toEqual([{ decisionId: 'd-build', text: 'mage' }]);
  }, 10_000);

  it('character_creation: stat allocation + done + build pick → JSON envelope', async () => {
    const { delivered, transcript } = await runCase(
      'd-cc',
      {
        kind: 'character_creation',
        stats: [
          { id: 'STR', label: 'Strength', min: 1, max: 10 },
          { id: 'AGI', label: 'Agility', min: 1, max: 10 },
        ],
        statBudget: 10,
        options: [
          { id: 'warrior', label: 'Warrior' },
          { id: 'rogue', label: 'Rogue' },
        ],
      },
      ['6', '4', 'done', '2'],
    );
    expect(transcript).toContain('Character creation');
    expect(delivered).toHaveLength(1);
    expect(delivered[0].decisionId).toBe('d-cc');
    const envelope = JSON.parse(delivered[0].text);
    expect(envelope).toEqual({
      stats: { STR: 6, AGI: 4 },
      build: 'rogue',
    });
  }, 10_000);

  it('unknown kind: falls back to generic prompt and still round-trips', async () => {
    const { delivered, transcript } = await runCase(
      'd-x',
      {
        kind: 'mystery-modal',
        options: [
          { id: 'left', label: 'Left' },
          { id: 'right', label: 'Right' },
        ],
      },
      ['2'],
    );
    expect(transcript).toContain('mystery-modal');
    expect(transcript).toContain('[1] Left');
    expect(delivered).toEqual([{ decisionId: 'd-x', text: 'right' }]);
  }, 10_000);
});
