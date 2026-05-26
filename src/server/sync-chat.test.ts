/**
 * Integration tests for `POST /chat/sync` (issue #736).
 *
 * Spins up the real HTTP server with a real `IdleSession` driven by
 * `NoopProvider`. Same harness shape as `server.test.ts` but with the
 * synchronous endpoint as the surface under test.
 */

import { describe, expect, it } from 'vitest';
import { LoopRunner } from '../loop/runner.js';
import { IdleSession } from '../loop/session.js';
import { NoopProvider } from '../llm/noop.js';
import type {
  GenerateRequest,
  GenerateResult,
  LlmResult,
  LlmProvider,
  StreamEvent,
} from '../llm/provider.js';

/**
 * Wraps an `LlmProvider`, sleeping `delayMs` before each generate result.
 * Lets us simulate a slow LLM deterministically — needed for the 409
 * (concurrent in-flight) and 504 (timeout) tests below.
 */
class SlowProvider implements LlmProvider {
  readonly name: string;
  constructor(
    private readonly inner: LlmProvider,
    private readonly delayMs: number,
  ) {
    this.name = inner.name;
  }
  async generate(req: GenerateRequest): Promise<LlmResult<GenerateResult>> {
    await new Promise<void>((r) => setTimeout(r, this.delayMs));
    return this.inner.generate(req);
  }
  // eslint-disable-next-line require-yield
  async *streamGenerate(_req: GenerateRequest): AsyncIterable<StreamEvent> {
    // Sync endpoint goes through `generate()`, not the streaming surface
    // — leaving this empty is safe for these tests.
    return;
  }
}
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
import type { TurnResult } from './assemble-turn.js';

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

interface BringUpOpts {
  syncChatTimeoutMs?: number;
  /** Insert an artificial delay (ms) before the LLM returns each frame. */
  llmDelayMs?: number;
}

async function bringUp(opts: BringUpOpts = {}): Promise<Harness> {
  const hub = new EventHub();
  const verifier = new StaticDevVerifier([['tok-good', 'uid-1']]);

  const registry = new SessionRegistry((uid, characterId) => {
    const emit = hub.emitterFor(uid, characterId);
    return new IdleSession({
      runnerFactory: () => {
        const noop = new NoopProvider({
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
        const llm: LlmProvider =
          opts.llmDelayMs !== undefined
            ? new SlowProvider(noop, opts.llmDelayMs)
            : noop;
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
    ...(opts.syncChatTimeoutMs !== undefined
      ? { syncChatTimeoutMs: opts.syncChatTimeoutMs }
      : {}),
  });
  const port = await server.listen(0);
  return { server, port, hub, registry };
}

describe('POST /chat/sync', () => {
  it('rejects without bearer token (401)', async () => {
    const { server, port } = await bringUp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/chat/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 's', characterId: 'c', message: 'hi' }),
      });
      expect(res.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('rejects empty message (400)', async () => {
    const { server, port } = await bringUp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/chat/sync`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer tok-good',
        },
        body: JSON.stringify({
          sessionId: 's',
          characterId: 'c',
          message: '   ',
        }),
      });
      expect(res.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it('end-to-end: returns assembled TurnResult with tool call + narration', async () => {
    const { server, port } = await bringUp();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/chat/sync`, {
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
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        sessionId: string;
        characterId: string;
        turn: TurnResult;
      };
      expect(body.sessionId).toBe('sess-1');
      expect(body.characterId).toBe('char-1');
      expect(body.turn.userMessage).toBe('Where am I?');
      expect(body.turn.stopReason).toBe('end_turn');
      expect(body.turn.toolCalls.length).toBeGreaterThanOrEqual(1);
      expect(body.turn.toolCalls[0].name).toBe('look');
      expect(body.turn.toolResults.length).toBeGreaterThanOrEqual(1);
      expect(body.turn.toolResults[0].status).toBe('ok');
      // The narration comes from `INTENT:` text-line parsing inside the
      // runner. End-turn assistant text concatenates the final reply.
      expect(body.turn.assistantText).toContain('torchlit hall');
    } finally {
      await server.close();
    }
  });

  it('returns 409 turn_in_progress when a sync POST arrives mid-turn', async () => {
    // Use a slow LLM so the first POST is still running when the second fires.
    const { server, port } = await bringUp({ llmDelayMs: 200 });
    try {
      const url = `http://127.0.0.1:${port}/chat/sync`;
      const headers = {
        'content-type': 'application/json',
        authorization: 'Bearer tok-good',
      };
      const body = JSON.stringify({
        sessionId: 's',
        characterId: 'char-busy',
        message: 'first',
      });

      const first = fetch(url, { method: 'POST', headers, body });
      // Yield enough for the first POST to reach `deliverUserMessage`.
      await new Promise<void>((r) => setTimeout(r, 30));

      const second = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sessionId: 's',
          characterId: 'char-busy',
          message: 'second',
        }),
      });
      expect(second.status).toBe(409);
      const secondBody = (await second.json()) as { error: string };
      expect(secondBody.error).toBe('turn_in_progress');

      const firstRes = await first;
      expect(firstRes.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('returns 504 with partialTurn on timeout', async () => {
    // 5ms budget — the turn cannot finish that fast.
    const { server, port } = await bringUp({
      syncChatTimeoutMs: 5,
      llmDelayMs: 100,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/chat/sync`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer tok-good',
        },
        body: JSON.stringify({
          sessionId: 's',
          characterId: 'char-slow',
          message: 'hi',
        }),
      });
      expect(res.status).toBe(504);
      const body = (await res.json()) as {
        error: string;
        partialTurn: TurnResult;
      };
      expect(body.error).toBe('timeout');
      expect(body.partialTurn).toBeDefined();
      expect(body.partialTurn.stopReason).toBe('timeout');
    } finally {
      await server.close();
    }
  });
});
