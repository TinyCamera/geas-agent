/**
 * GeasMcpClient unit tests.
 *
 * These run against an in-memory MCP server (no network) using
 * `InMemoryTransport.createLinkedPair()`. The fake server registers every
 * name in `GEAS_TOOL_NAMES` so the wrapper's drift check passes on connect.
 *
 * Specific drop / reconnect / error scenarios then poke at individual tools:
 *   - happy-path call + typed response
 *   - server-reported tool error → `kind:'tool_error'` Err
 *   - drift detection (missing tool → `kind:'invalid_response'` on connect)
 *   - drift detection (extra tool → warning, connect still succeeds)
 *   - simulated transport drop → wrapper reconnects + retries successfully
 *     (this is the integration-test acceptance criterion from #579; the
 *     in-memory transport faithfully exercises the SDK's request/response
 *     lifecycle even though there's no socket to physically drop, so this
 *     is testing the wrapper's retry-on-throw behavior, which is what
 *     matters for callers)
 *   - error-shape contract: every Err has {kind, message}
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { GeasMcpClient } from './client.js';
import { GEAS_TOOL_NAMES, type GeasToolName } from './tools.js';

/**
 * Build a fake server that registers every tool the wrapper expects. By
 * default every tool returns `{ ok: true, name }` via structuredContent so
 * tests can assert tool dispatch worked. Per-test overrides let individual
 * tests inject failures.
 */
type ToolOverride = (args: Record<string, unknown>) => unknown;

function buildFakeServer(
  overrides: Partial<Record<string, ToolOverride>> = {},
  options: { omit?: GeasToolName[]; extras?: string[] } = {},
): McpServer {
  const server = new McpServer({ name: 'fake-geas-server', version: '0.0.1' });
  const omit = new Set(options.omit ?? []);
  const allNames: string[] = [
    ...GEAS_TOOL_NAMES.filter((n) => !omit.has(n)),
    ...(options.extras ?? []),
  ];
  for (const name of allNames) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).registerTool(
      name,
      { title: name, description: `fake ${name}` },
      async (args: Record<string, unknown>) => {
        const override = overrides[name];
        if (override) return override(args);
        const payload = { ok: true, name, echoed: args };
        return {
          content: [{ type: 'text', text: `ok:${name}` }],
          structuredContent: payload,
        };
      },
    );
  }
  return server;
}

async function linkClientToServer(
  client: GeasMcpClient,
  server: McpServer,
): Promise<{ clientTransport: Transport; serverTransport: Transport }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  // Inject the transport via the override factory.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).opts.transportFactory = () => clientTransport;
  return { clientTransport, serverTransport };
}

function makeClient(opts: Partial<ConstructorParameters<typeof GeasMcpClient>[0]> = {}) {
  return new GeasMcpClient({
    url: 'http://localhost:1/mcp',
    reconnectBaseMs: 1,
    reconnectMaxMs: 5,
    reconnectMaxAttempts: 3,
    requestTimeoutMs: 2_000,
    ...opts,
  });
}

describe('GeasMcpClient', () => {
  let client: GeasMcpClient;
  let server: McpServer;

  afterEach(async () => {
    await client?.disconnect();
    await server?.close();
  });

  describe('connect()', () => {
    it('validates the full tool surface on connect (happy path)', async () => {
      server = buildFakeServer();
      client = makeClient();
      await linkClientToServer(client, server);
      const res = await client.connect();
      expect(res.ok).toBe(true);
      expect(client.isConnected()).toBe(true);
    });

    it('returns invalid_response when the server is missing a required tool', async () => {
      server = buildFakeServer({}, { omit: ['look'] });
      client = makeClient();
      await linkClientToServer(client, server);
      const res = await client.connect();
      expect(res.ok).toBe(false);
      if (res.ok) return; // narrow
      expect(res.error.kind).toBe('invalid_response');
      expect(res.error.message).toMatch(/look/);
      expect(client.isConnected()).toBe(false);
    });

    it('emits a warning (but still succeeds) when server exposes unknown tools', async () => {
      server = buildFakeServer({}, { extras: ['some_future_tool'] });
      const warnings: string[] = [];
      client = makeClient({ onWarning: (m) => warnings.push(m) });
      await linkClientToServer(client, server);
      const res = await client.connect();
      expect(res.ok).toBe(true);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toMatch(/some_future_tool/);
    });

    it('is idempotent — concurrent connects share the same promise', async () => {
      server = buildFakeServer();
      client = makeClient();
      await linkClientToServer(client, server);
      const [a, b] = await Promise.all([client.connect(), client.connect()]);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
    });
  });

  describe('callTool()', () => {
    beforeEach(async () => {
      server = buildFakeServer();
      client = makeClient();
      await linkClientToServer(client, server);
      const r = await client.connect();
      expect(r.ok).toBe(true);
    });

    it('returns the parsed response on success', async () => {
      const res = await client.callTool('look', {});
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.structuredContent).toMatchObject({ ok: true, name: 'look' });
    });

    it('typed convenience methods route through callTool', async () => {
      const res = await client.status();
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.structuredContent).toMatchObject({ name: 'status' });
    });

    it('passes args through to the server', async () => {
      // Rewire `act` with an explicit input schema so the SDK forwards the
      // args object as the handler's first argument (without a schema, the
      // SDK treats it as a no-arg tool and the handler only receives `extra`).
      await client.disconnect();
      // zod v3 exports `z` as a namespace; v4 exports it as the default
      // module. Accept either so the test isn't pinned to a single major.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const zmod: any = await import('zod');
      const z = zmod.z ?? zmod;
      let captured: unknown = null;
      const customServer = new McpServer({ name: 'fake', version: '0.0.1' });
      for (const name of GEAS_TOOL_NAMES) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (customServer as any).registerTool(
          name,
          {
            title: name,
            description: name,
            inputSchema:
              name === 'act'
                ? { intent: z.string(), dx: z.number(), dy: z.number() }
                : {},
          },
          async (args: Record<string, unknown>) => {
            if (name === 'act') captured = args;
            return {
              content: [{ type: 'text', text: 'ok' }],
              structuredContent: { name },
            };
          },
        );
      }
      server = customServer;
      client = makeClient();
      await linkClientToServer(client, server);
      await client.connect();
      const res = await client.act({ intent: 'move', dx: 1, dy: 0 });
      expect(res.ok).toBe(true);
      expect(captured).toMatchObject({ intent: 'move', dx: 1, dy: 0 });
    });

    it('maps server-reported isError into a tool_error Err', async () => {
      // Rewire `look` to return isError.
      await client.disconnect();
      server = buildFakeServer({
        look: () => ({
          content: [{ type: 'text', text: 'something broke server-side' }],
          isError: true,
        }),
      });
      client = makeClient();
      await linkClientToServer(client, server);
      await client.connect();

      const res = await client.look();
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.kind).toBe('tool_error');
      expect(res.error.tool).toBe('look');
      expect(res.error.message).toMatch(/something broke/);
    });

    it('refuses to call after disconnect()', async () => {
      await client.disconnect();
      const res = await client.callTool('look', {});
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.kind).toBe('not_connected');
    });

    it('honors AbortSignal', async () => {
      const ac = new AbortController();
      ac.abort();
      const res = await client.callTool('look', {}, { signal: ac.signal });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.kind).toBe('aborted');
    });
  });

  describe('pre-dispatch validation (#658)', () => {
    // For these tests we need the fake server to advertise real `inputSchema`
    // entries so the wrapper's cache is populated with shapes worth checking.
    // Build a custom server with explicit Zod schemas for `act` (requires
    // intent: string) and `nearest` (optional maxDist: number).
    async function buildSchemaServer(): Promise<McpServer> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const zmod: any = await import('zod');
      const z = zmod.z ?? zmod;
      const srv = new McpServer({ name: 'fake-schema', version: '0.0.1' });
      for (const name of GEAS_TOOL_NAMES) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (srv as any).registerTool(
          name,
          {
            title: name,
            description: name,
            inputSchema:
              name === 'act'
                ? { intent: z.string(), dx: z.number().optional(), dy: z.number().optional() }
                : name === 'nearest'
                  ? { type: z.string().optional(), maxDist: z.number().optional(), aliveOnly: z.boolean().optional() }
                  : name === 'create_character'
                    ? { name: z.string() }
                    : {},
          },
          async (args: Record<string, unknown>) => ({
            content: [{ type: 'text', text: `ok:${name}` }],
            structuredContent: { name, args },
          }),
        );
      }
      return srv;
    }

    it('rejects unknown tool names locally without a server round-trip', async () => {
      server = await buildSchemaServer();
      client = makeClient();
      await linkClientToServer(client, server);
      const c = await client.connect();
      expect(c.ok).toBe(true);
      const res = await client.callTool('not_a_real_tool', {});
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.kind).toBe('unknown_tool');
      expect(res.error.tool).toBe('not_a_real_tool');
    });

    it('rejects missing required args', async () => {
      server = await buildSchemaServer();
      client = makeClient();
      await linkClientToServer(client, server);
      await client.connect();
      const res = await client.callTool('act', { dx: 1 }); // missing intent
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.kind).toBe('missing_required');
      expect(res.error.args).toContain('intent');
    });

    it('rejects wrong arg types', async () => {
      server = await buildSchemaServer();
      client = makeClient();
      await linkClientToServer(client, server);
      await client.connect();
      // intent must be string; passing a number should fail locally.
      const res = await client.callTool('act', { intent: 42 });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.kind).toBe('wrong_type');
      expect(res.error.args).toEqual(['intent']);
    });

    it('warns (but does not fail) on extra args', async () => {
      const warnings: string[] = [];
      server = await buildSchemaServer();
      client = makeClient({ onWarning: (m) => warnings.push(m) });
      await linkClientToServer(client, server);
      await client.connect();
      const res = await client.callTool('act', { intent: 'move', surprise: 'x' });
      expect(res.ok).toBe(true);
      const validationWarn = warnings.find((w) => w.includes('surprise'));
      expect(validationWarn).toBeDefined();
    });

    it('valid calls dispatch through to the server', async () => {
      server = await buildSchemaServer();
      client = makeClient();
      await linkClientToServer(client, server);
      await client.connect();
      const res = await client.callTool('act', { intent: 'move', dx: 1, dy: 0 });
      expect(res.ok).toBe(true);
    });

    it('does not flag the binding envelope (_agentBinding) as an extra', async () => {
      const warnings: string[] = [];
      server = await buildSchemaServer();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { createBinding } = await import('../binding/index.js');
      client = makeClient({
        onWarning: (m) => warnings.push(m),
        binding: createBinding({
          entityId: 'e1',
          ownerUid: 'u1',
          bindingMode: 'agent-only',
        }),
      });
      await linkClientToServer(client, server);
      await client.connect();
      const res = await client.callTool('act', { intent: 'move' });
      expect(res.ok).toBe(true);
      const bindingWarn = warnings.find((w) => w.includes('_agentBinding'));
      expect(bindingWarn).toBeUndefined();
    });
  });

  describe('reconnect-on-drop', () => {
    it('transparently reconnects when the transport is dropped between calls', async () => {
      // We need a transport factory that can be re-invoked to give a *fresh*
      // linked pair each time the wrapper rebuilds — exactly the behavior a
      // network transport gives for free. Track invocations + rewire server.
      let serverInst: McpServer | null = null;
      const factory = (): Transport => {
        const [c, s] = InMemoryTransport.createLinkedPair();
        // Build a fresh server bound to this transport. Closing the previous
        // one is fine — the wrapper has already torn its side down.
        serverInst?.close().catch(() => {});
        serverInst = buildFakeServer();
        serverInst.connect(s).catch(() => {});
        return c;
      };
      client = new GeasMcpClient({
        url: 'http://unused/mcp',
        reconnectBaseMs: 1,
        reconnectMaxMs: 5,
        reconnectMaxAttempts: 3,
        transportFactory: factory,
      });
      const first = await client.connect();
      expect(first.ok).toBe(true);

      // Sanity — call works pre-drop.
      const before = await client.callTool('status', {});
      expect(before.ok).toBe(true);

      // Force a drop. Next call should rebuild the transport and succeed.
      await client._testForceDrop();
      expect(client.isConnected()).toBe(false);

      const after = await client.callTool('status', {});
      expect(after.ok).toBe(true);
      expect(client.isConnected()).toBe(true);

      // Cleanup
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      server = (serverInst as any) ?? buildFakeServer();
    });

    it('gives up after reconnectMaxAttempts when the transport stays broken', async () => {
      let attempts = 0;
      const factory = (): Transport => {
        attempts++;
        // Return a transport that throws on `start()` — simulates server
        // being permanently down.
        return {
          start: async () => {
            throw new Error('connection refused');
          },
          send: async () => {
            throw new Error('connection refused');
          },
          close: async () => {},
        } as Transport;
      };
      client = new GeasMcpClient({
        url: 'http://unused/mcp',
        reconnectBaseMs: 1,
        reconnectMaxMs: 2,
        reconnectMaxAttempts: 2,
        transportFactory: factory,
      });
      const res = await client.callTool('look', {});
      expect(res.ok).toBe(false);
      if (res.ok) return;
      // Could be transport or invalid_response depending on which layer fails first;
      // both are non-retryable-from-the-caller's-perspective at this point.
      expect(['transport', 'invalid_response']).toContain(res.error.kind);
      // We tried at least twice (initial + retries).
      expect(attempts).toBeGreaterThanOrEqual(2);
      server = buildFakeServer(); // satisfy afterEach
    });
  });

  describe('error-shape contract', () => {
    it('every Err has {kind, message} and optional tool', async () => {
      server = buildFakeServer({}, { omit: ['look'] });
      client = makeClient();
      await linkClientToServer(client, server);
      const r = await client.connect();
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(typeof r.error.kind).toBe('string');
      expect(typeof r.error.message).toBe('string');
      expect(r.error.kind).toBe('invalid_response');
    });

    it('makeError preserves cause without leaking through ok-path', async () => {
      server = buildFakeServer({
        look: () => {
          throw new Error('boom');
        },
      });
      client = makeClient();
      await linkClientToServer(client, server);
      await client.connect();
      const res = await client.look();
      expect(res.ok).toBe(false);
      if (res.ok) return;
      // The SDK wraps thrown handler errors into tool errors (isError: true)
      // or transport-level errors depending on lifecycle. Either is acceptable;
      // both must carry a message.
      expect(['tool_error', 'transport']).toContain(res.error.kind);
      expect(res.error.message.length).toBeGreaterThan(0);
    });
  });

  describe('listTools()', () => {
    it('returns the live server tool surface', async () => {
      server = buildFakeServer();
      client = makeClient();
      await linkClientToServer(client, server);
      await client.connect();
      const res = await client.listTools();
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const names = res.value.map((t) => t.name).sort();
      for (const expected of GEAS_TOOL_NAMES) {
        expect(names).toContain(expected);
      }
    });
  });
});
