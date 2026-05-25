/**
 * Integration test for the production entrypoint (#730).
 *
 * Proves the wiring in `src/index-server.ts` actually composes — the
 * `SessionFactory` builds an `IdleSession` driving a `LoopRunner` driven
 * by a `(NoopProvider → TelemetryProvider)` whose records project onto
 * Channel A, against a `GeasMcpClient` over an in-memory MCP transport.
 *
 * **No Anthropic key needed.** We pass `llmOverride: new NoopProvider(...)`
 * so this test runs anywhere — local dev, CI, no env vars set. The
 * production `main()` path always goes through `AnthropicProvider` (and
 * fails-fast without `ANTHROPIC_API_KEY`); the test surface is `bootServer`
 * which accepts the override.
 *
 * **What this test asserts.**
 *
 *   1. `bootServer` returns a `BootedServer` with a bound port and a
 *      working HTTP/WS surface.
 *   2. POST /chat → 202 Accepted, then the WS stream emits the model's
 *      `text` event over Channel A.
 *   3. A `telemetry` event also rides Channel A (from #725's wiring) —
 *      proves the per-session `TelemetryProvider` is in the chain.
 *   4. `GET /healthz` answers 200.
 *
 * The MCP server is the same `InMemoryTransport`-linked fake the
 * `GeasMcpClient` unit tests use — every `GEAS_TOOL_NAMES` entry
 * registers a benign `{ok:true}` responder.
 */

import { describe, it, expect } from 'vitest';
import WebSocket from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { bootServer, readBootConfigFromEnv } from './index-server.js';
import { NoopProvider } from './llm/noop.js';
import { GeasMcpClient } from './mcp/client.js';
import { GEAS_TOOL_NAMES } from './mcp/tools.js';
import {
  PROTOCOL_VERSION,
  type ChannelAEvent,
} from './server/wire.js';

function buildFakeServer(): McpServer {
  const server = new McpServer({ name: 'fake-geas-server', version: '0.0.1' });
  for (const name of GEAS_TOOL_NAMES) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).registerTool(
      name,
      { title: name, description: `fake ${name}` },
      async () => ({
        content: [{ type: 'text', text: `ok:${name}` }],
        structuredContent: { ok: true, name },
      }),
    );
  }
  return server;
}

async function buildLinkedMcpClient(): Promise<{
  client: GeasMcpClient;
  server: McpServer;
}> {
  const server = buildFakeServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new GeasMcpClient({
    url: 'http://in-memory/mcp',
    reconnectBaseMs: 1,
    reconnectMaxAttempts: 1,
    requestTimeoutMs: 2_000,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).opts.transportFactory = () => clientTransport;
  const conn = await client.connect();
  if (!conn.ok) throw new Error(`linked mcp connect: ${conn.error.message}`);
  return { client, server };
}

function openWs(
  port: number,
  q: Record<string, string>,
): Promise<{ ws: WebSocket; events: ChannelAEvent[] }> {
  const qs = new URLSearchParams(q).toString();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/events?${qs}`);
  const events: ChannelAEvent[] = [];
  ws.on('message', (raw) => {
    const text = typeof raw === 'string' ? raw : (raw as Buffer).toString();
    events.push(JSON.parse(text) as ChannelAEvent);
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, events }));
    ws.once('error', reject);
  });
}

async function waitFor<T>(
  predicate: () => T | null,
  timeoutMs = 4000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = predicate();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitFor: timeout after ${timeoutMs}ms`);
}

describe('readBootConfigFromEnv', () => {
  it('defaults sensibly when env is empty', () => {
    const cfg = readBootConfigFromEnv({});
    expect(cfg.mcpUrl).toBe('http://localhost:8088/mcp');
    expect(cfg.devUid).toBe('agent-dev');
    expect(cfg.port).toBe(3001);
    expect(cfg.anthropicApiKey).toBeNull();
    expect(cfg.useFirestore).toBe(false);
  });

  it('reads overrides from env', () => {
    const cfg = readBootConfigFromEnv({
      GEAS_MCP_URL: 'http://example/mcp',
      GEAS_DEV_UID: 'alice',
      GEAS_AGENT_PORT: '4321',
      ANTHROPIC_API_KEY: 'sk-test',
      FIRESTORE_EMULATOR_HOST: 'localhost:8080',
      GEAS_BEARER_TOKEN: 'tok',
    });
    expect(cfg.mcpUrl).toBe('http://example/mcp');
    expect(cfg.devUid).toBe('alice');
    expect(cfg.port).toBe(4321);
    expect(cfg.anthropicApiKey).toBe('sk-test');
    expect(cfg.bearerToken).toBe('tok');
    expect(cfg.useFirestore).toBe(true);
  });

  it('throws on a non-positive port', () => {
    expect(() => readBootConfigFromEnv({ GEAS_AGENT_PORT: '0' })).toThrow();
    expect(() => readBootConfigFromEnv({ GEAS_AGENT_PORT: 'abc' })).toThrow();
  });
});

describe('bootServer — end-to-end (NoopProvider + in-memory MCP)', () => {
  it('answers /healthz', async () => {
    const { client: mcpClient, server: fakeMcp } =
      await buildLinkedMcpClient();
    const booted = await bootServer({
      mcpUrl: 'http://in-memory/mcp',
      devUid: 'agent-dev',
      port: 0,
      anthropicApiKey: null,
      useFirestore: false,
      llmOverride: new NoopProvider({ script: [] }),
      mcpOverride: mcpClient,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${booted.port}/healthz`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    } finally {
      await booted.close();
      await fakeMcp.close();
    }
  });

  it('runs a full turn: POST /chat → text event over WS', async () => {
    const { client: mcpClient, server: fakeMcp } =
      await buildLinkedMcpClient();

    // Script: end_turn with a plain text response. The runner emits this
    // as a `text` Channel-A event after the model's last block lands.
    const provider = new NoopProvider({
      script: [
        {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: 'Hello from the agent.' }],
        },
      ],
    });

    const booted = await bootServer({
      mcpUrl: 'http://in-memory/mcp',
      devUid: 'agent-dev',
      port: 0,
      anthropicApiKey: null,
      useFirestore: false,
      llmOverride: provider,
      mcpOverride: mcpClient,
    });

    try {
      // Open the WS first so events buffer from the start of the turn.
      const { ws, events } = await openWs(booted.port, {
        token: 'dev-token',
        characterId: 'char-1',
      });

      // POST /chat — the static dev verifier accepts `dev-token` → uid=agent-dev.
      const res = await fetch(`http://127.0.0.1:${booted.port}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer dev-token',
        },
        body: JSON.stringify({
          sessionId: 'sess-1',
          characterId: 'char-1',
          message: 'Hi there!',
        }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { accepted: boolean };
      expect(body.accepted).toBe(true);

      // The runner's `text-delta`/`done` flow projects onto Channel A as
      // a `text` event (see EventHub.emitterFor). Wait for one.
      const textEvent = await waitFor(() => {
        const t = events.find(
          (e) =>
            e.type === 'text' &&
            typeof (e as { text?: unknown }).text === 'string' &&
            (e as { text: string }).text.includes('Hello from the agent.'),
        );
        return t ?? null;
      });
      expect(textEvent.protocolVersion).toBe(PROTOCOL_VERSION);

      // And the TelemetryProvider should have emitted a telemetry event
      // for the round-trip (#725 wiring).
      const telemetry = events.find((e) => e.type === 'telemetry');
      expect(telemetry).toBeDefined();

      ws.close();
    } finally {
      await booted.close();
      await fakeMcp.close();
    }
  });
});
