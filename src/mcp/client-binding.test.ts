/**
 * GeasMcpClient × AgentBinding plumbing tests.
 *
 * Verifies that when a binding is supplied at construction:
 *
 *   1. The binding is exposed via `client.binding`.
 *   2. Every `callTool` invocation carries the binding under the reserved
 *      `_agentBinding` key in the tool args envelope (server can read it for
 *      logs / future per-request enforcement; today it's informational).
 *   3. Callers that explicitly pass `_agentBinding` keep their value — the
 *      wrapper does not overwrite.
 *   4. Clients constructed *without* a binding leave args untouched (no
 *      surprise field appears).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

import { GeasMcpClient } from './client.js';
import { GEAS_TOOL_NAMES } from './tools.js';
import { createBinding } from '../binding/index.js';

/**
 * Registers every expected tool with a permissive passthrough inputSchema —
 * `z.any()` per field — so the SDK doesn't strip unknown args before our
 * handler sees them. This is exactly the surface we need to assert that the
 * wrapper's binding injection arrives at the server.
 */
function buildEchoServer(): McpServer {
  const server = new McpServer({ name: 'echo', version: '0.0.1' });
  // A permissive passthrough: SDK uses each field's zod schema to validate,
  // but a single `_passthrough` lets all extra keys ride along on the wire as
  // part of the args object the handler receives.
  for (const name of GEAS_TOOL_NAMES) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).registerTool(
      name,
      {
        title: name,
        description: `echo ${name}`,
        inputSchema: {
          intent: z.any().optional(),
          x: z.any().optional(),
          y: z.any().optional(),
          foo: z.any().optional(),
          _agentBinding: z.any().optional(),
        },
      },
      async (args: Record<string, unknown>) => ({
        content: [{ type: 'text', text: `ok:${name}` }],
        structuredContent: { name, args },
      }),
    );
  }
  return server;
}

async function link(client: GeasMcpClient, server: McpServer) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).opts.transportFactory = () => a;
}

describe('GeasMcpClient × AgentBinding', () => {
  let client: GeasMcpClient;
  let server: McpServer;

  afterEach(async () => {
    await client?.disconnect();
    await server?.close();
  });

  it('exposes the binding via getter', () => {
    const binding = createBinding({
      entityId: 'e_42',
      ownerUid: 'user_nick',
      bindingMode: 'agent-only',
    });
    client = new GeasMcpClient({ url: 'http://localhost:1/mcp', binding });
    expect(client.binding).toBe(binding);
    expect(client.binding?.entityId).toBe('e_42');
  });

  it('returns undefined when no binding was provided', () => {
    client = new GeasMcpClient({ url: 'http://localhost:1/mcp' });
    expect(client.binding).toBeUndefined();
  });

  it('injects _agentBinding into every callTool args envelope', async () => {
    const binding = createBinding({
      entityId: 'e_42',
      ownerUid: 'user_nick',
      bindingMode: 'agent-only',
    });
    server = buildEchoServer();
    client = new GeasMcpClient({
      url: 'http://localhost:1/mcp',
      binding,
      reconnectBaseMs: 1,
      reconnectMaxMs: 5,
      reconnectMaxAttempts: 1,
    });
    await link(client, server);
    const r = await client.callTool('look', {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const echoed = r.value.structuredContent as { name: string; args: Record<string, unknown> };
    expect(echoed.args._agentBinding).toEqual({
      entityId: 'e_42',
      ownerUid: 'user_nick',
      bindingMode: 'agent-only',
    });
  });

  it('preserves caller-supplied args alongside the injected binding', async () => {
    const binding = createBinding({
      entityId: 'e_1',
      ownerUid: 'u',
      bindingMode: 'agent-only',
    });
    server = buildEchoServer();
    client = new GeasMcpClient({ url: 'http://localhost:1/mcp', binding, reconnectBaseMs: 1, reconnectMaxAttempts: 1 });
    await link(client, server);
    const r = await client.callTool('act', { intent: 'move', x: 5, y: 7 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const args = (r.value.structuredContent as { args: Record<string, unknown> }).args;
    expect(args.intent).toBe('move');
    expect(args.x).toBe(5);
    expect(args.y).toBe(7);
    expect(args._agentBinding).toMatchObject({ entityId: 'e_1', bindingMode: 'agent-only' });
  });

  it('does not overwrite an explicit _agentBinding from the caller', async () => {
    const binding = createBinding({
      entityId: 'e_default',
      ownerUid: 'u',
      bindingMode: 'agent-only',
    });
    server = buildEchoServer();
    client = new GeasMcpClient({ url: 'http://localhost:1/mcp', binding, reconnectBaseMs: 1, reconnectMaxAttempts: 1 });
    await link(client, server);
    const explicit = { entityId: 'override', ownerUid: 'override_u', bindingMode: 'player-direct' };
    const r = await client.callTool('look', { _agentBinding: explicit });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const args = (r.value.structuredContent as { args: Record<string, unknown> }).args;
    expect(args._agentBinding).toEqual(explicit);
  });

  it('does not inject _agentBinding when no binding is configured', async () => {
    server = buildEchoServer();
    client = new GeasMcpClient({ url: 'http://localhost:1/mcp', reconnectBaseMs: 1, reconnectMaxAttempts: 1 });
    await link(client, server);
    const r = await client.callTool('look', { foo: 'bar' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const args = (r.value.structuredContent as { args: Record<string, unknown> }).args;
    expect(args.foo).toBe('bar');
    expect(args._agentBinding).toBeUndefined();
  });
});
