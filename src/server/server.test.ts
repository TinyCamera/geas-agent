/**
 * Integration: spin up the real HTTP+WS server, plug in a real
 * `IdleSession` driving a real `LoopRunner` driven by `NoopProvider`,
 * and assert the wire contract end-to-end.
 *
 * Per issue #667 acceptance criteria:
 *   - REPL can connect end-to-end and exchange one message round-trip.
 *   - Reconnect after transient disconnect works (resume same session).
 *   - Auth rejects invalid ID tokens.
 */

import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { LoopRunner } from '../loop/runner.js';
import { IdleSession } from '../loop/session.js';
import { NoopProvider } from '../llm/noop.js';
import { createStuckDetector } from '../prompts/stuck.js';
import { createRetryBudget } from '../prompts/budget.js';
import { ok, err, makeError, type Result } from '../mcp/errors.js';
import type { GeasToolResponse } from '../mcp/tools.js';
import type { LlmToolDef } from '../llm/provider.js';
import type { AttemptPlan, RecoveryDriver } from '../loop/run-with-retry.js';
import { StaticDevVerifier } from './auth.js';
import { EventHub } from './hub.js';
import { SessionRegistry } from './session-registry.js';
import { createServer, type RunningServer } from './server.js';
import { PROTOCOL_VERSION, type ChannelAEvent } from './wire.js';

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

interface Harness {
  server: RunningServer;
  port: number;
  hub: EventHub;
  registry: SessionRegistry;
}

async function bringUp(): Promise<Harness> {
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
      // Tighten the idle threshold so tests don't drag.
      idleThresholdMs: 50,
    });
  });

  const server = createServer({
    verifier,
    hub,
    registry,
    pingIntervalMs: 0, // suppress pings in tests
  });
  const port = await server.listen(0);
  return { server, port, hub, registry };
}

async function readEvents(
  bws: BufferedWs,
  predicate: (e: ChannelAEvent) => boolean,
  timeoutMs = 4000,
): Promise<ChannelAEvent[]> {
  const got: ChannelAEvent[] = [];
  return new Promise<ChannelAEvent[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `timeout after ${timeoutMs}ms; got ${got.length} events: ${JSON.stringify(
            got.map((e) => e.type),
          )}`,
        ),
      );
    }, timeoutMs);
    bws.onMessage((ev) => {
      got.push(ev);
      if (predicate(ev)) {
        clearTimeout(timer);
        resolve(got);
      }
    });
    bws.ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

interface BufferedWs {
  ws: WebSocket;
  buffered: ChannelAEvent[];
  onMessage: (cb: (e: ChannelAEvent) => void) => void;
}

function openWs(port: number, q: Record<string, string>): Promise<BufferedWs> {
  const qs = new URLSearchParams(q).toString();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/events?${qs}`);
  const buffered: ChannelAEvent[] = [];
  let drain: ((e: ChannelAEvent) => void) | null = null;
  ws.on('message', (raw) => {
    const text = typeof raw === 'string' ? raw : (raw as Buffer).toString();
    const ev = JSON.parse(text) as ChannelAEvent;
    if (drain) drain(ev);
    else buffered.push(ev);
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () =>
      resolve({
        ws,
        buffered,
        onMessage: (cb) => {
          for (const e of buffered.splice(0)) cb(e);
          drain = cb;
        },
      }),
    );
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`ws upgrade rejected ${res.statusCode}`));
    });
    ws.once('error', reject);
  });
}

describe('Channel-A server', () => {
  it('healthz returns ok with protocol version', async () => {
    const { server, port } = await bringUp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; protocolVersion: number };
      expect(body.ok).toBe(true);
      expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
    } finally {
      await server.close();
    }
  });

  it('rejects POST /chat without bearer token (401)', async () => {
    const { server, port } = await bringUp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's', characterId: 'c', message: 'hi' }),
      });
      expect(res.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('rejects POST /chat with bad bearer token (401)', async () => {
    const { server, port } = await bringUp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer wrong',
        },
        body: JSON.stringify({ sessionId: 's', characterId: 'c', message: 'hi' }),
      });
      expect(res.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('rejects WS connect with bad token', async () => {
    const { server, port } = await bringUp();
    try {
      await expect(
        openWs(port, { token: 'wrong', characterId: 'c' }),
      ).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  it('end-to-end: connect WS, POST /chat, observe tool_call→tool_result→narration→done', async () => {
    const { server, port } = await bringUp();
    try {
      const bws = await openWs(port, {
        token: 'tok-good',
        characterId: 'char-1',
      });

      const helloP = readEvents(bws, (e) => e.type === 'hello');
      const hello = (await helloP).pop()!;
      expect(hello.type).toBe('hello');
      expect((hello as { resumeCursor: number }).resumeCursor).toBe(0);

      const donePromise = readEvents(bws, (e) => e.type === 'done');

      const res = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer tok-good',
        },
        body: JSON.stringify({
          sessionId: 'sess-1',
          characterId: 'char-1',
          message: 'Where am I?',
        }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { accepted: boolean; sessionId: string };
      expect(body.accepted).toBe(true);
      expect(body.sessionId).toBe('sess-1');

      const events = await donePromise;
      const types = events.map((e) => e.type);
      expect(types).toContain('tool_call');
      expect(types).toContain('tool_result');
      expect(types).toContain('narration');
      expect(types[types.length - 1]).toBe('done');

      // Every event must carry uid + characterId + protocolVersion + monotonic id.
      let prev = 0;
      for (const e of events) {
        expect(e.protocolVersion).toBe(PROTOCOL_VERSION);
        expect(e.uid).toBe('uid-1');
        expect(e.characterId).toBe('char-1');
        // hello carries resumeCursor as eventId (0 on cold start). Live
        // events strictly increase.
        if (e.type !== 'hello') {
          expect(e.eventId).toBeGreaterThan(prev);
          prev = e.eventId;
        }
      }

      bws.ws.close();
    } finally {
      await server.close();
    }
  });

  it('reconnect with lastEventId replays missed events', async () => {
    const { server, port, hub } = await bringUp();
    try {
      const bws1 = await openWs(port, {
        token: 'tok-good',
        characterId: 'char-2',
      });
      const done1 = readEvents(bws1, (e) => e.type === 'done');
      await fetch(`http://127.0.0.1:${port}/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer tok-good',
        },
        body: JSON.stringify({
          sessionId: 's',
          characterId: 'char-2',
          message: 'hi',
        }),
      });
      const all = await done1;
      bws1.ws.close();

      const liveEvents = all.filter((e) => e.type !== 'hello');
      expect(liveEvents.length).toBeGreaterThan(2);
      const resumeFrom = liveEvents[0].eventId;
      const expectedReplay = liveEvents.filter((e) => e.eventId > resumeFrom);

      const bws2 = await openWs(port, {
        token: 'tok-good',
        characterId: 'char-2',
        lastEventId: String(resumeFrom),
      });
      const got = await readEvents(bws2, (e) => e.type === 'hello');
      const replayed = got.filter((e) => e.type !== 'hello');
      expect(replayed.map((e) => e.eventId)).toEqual(
        expectedReplay.map((e) => e.eventId),
      );
      const hello = got.find((e) => e.type === 'hello')!;
      expect((hello as { resumeCursor: number }).resumeCursor).toBe(
        hub.lastEventId('uid-1', 'char-2'),
      );
      bws2.ws.close();
    } finally {
      await server.close();
    }
  });

  it('does not fan out events across UIDs', async () => {
    // Two verifiers in one map.
    const hub = new EventHub();
    const verifier = new StaticDevVerifier([
      ['tok-a', 'uid-a'],
      ['tok-b', 'uid-b'],
    ]);
    const registry = new SessionRegistry((uid, characterId) => {
      const emit = hub.emitterFor(uid, characterId);
      return new IdleSession({
        runnerFactory: () =>
          new LoopRunner({
            llm: new NoopProvider({
              script: [
                {
                  stopReason: 'end_turn',
                  content: [{ type: 'text', text: 'ok' }],
                },
              ],
            }),
            dispatch: staticDispatcher([]),
            stuckDetector: createStuckDetector(),
            retryBudget: createRetryBudget(),
            recover: neverRecover,
            tools: TOOLS,
            emit,
          }),
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
    try {
      const bwsA = await openWs(port, { token: 'tok-a', characterId: 'c' });
      const bwsB = await openWs(port, { token: 'tok-b', characterId: 'c' });

      const bSaw: ChannelAEvent[] = [];
      bwsB.onMessage((e) => bSaw.push(e));
      const aDone = readEvents(bwsA, (e) => e.type === 'done');
      await fetch(`http://127.0.0.1:${port}/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer tok-a',
        },
        body: JSON.stringify({
          sessionId: 's',
          characterId: 'c',
          message: 'hi',
        }),
      });
      await aDone;
      // B should only have its own hello, no cross-user events.
      expect(bSaw.every((e) => e.type === 'hello')).toBe(true);

      bwsA.ws.close();
      bwsB.ws.close();
    } finally {
      await server.close();
    }
  });
});
