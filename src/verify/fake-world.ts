/**
 * In-memory stateful fake geas-server for the verification harness (#673).
 *
 * **Why a *stateful* fake.** The fake MCP server the `GeasMcpClient` unit
 * tests use (`src/index-server.test.ts`) registers every tool as a benign
 * `{ok:true}` stub — fine for proving the wiring composes, useless for a
 * verification scenario whose whole point is "drive the agent, then assert the
 * *world changed*". This fake keeps a tiny mutable world (HP, position, level)
 * so a scenario's `act` actually moves the character and `asserts` can observe
 * it — all deterministic, in-process, no network, no LLM, no keys.
 *
 * **Coverage of the tool surface.** Every name in {@link GEAS_TOOL_NAMES} is
 * registered (the wrapper's connect-time drift check requires it). Most return
 * a benign `{ok:true}`; `status` / `look` reflect the live world; `act`
 * mutates it for the small set of intents the bundled scenarios exercise
 * (`move`, `attack`). Unknown intents are accepted as no-op `{ok:true}` so a
 * real-LLM run against this fake degrades gracefully rather than erroring.
 *
 * The shape deliberately mirrors `buildLinkedMcpClient()` in
 * `src/index-server.test.ts` (InMemoryTransport-linked client + server) so the
 * two stay recognizably the same fixture.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

import { GeasMcpClient } from '../mcp/index.js';
import { GEAS_TOOL_NAMES } from '../mcp/tools.js';
import type { VerifyWorld, WorldSeed, WorldSnapshot } from './types.js';

/** The mutable world the fake server owns. */
interface FakeWorldState {
  hp: number;
  maxHp: number;
  position: { x: number; y: number };
  level: number;
}

const DEFAULT_STATE: FakeWorldState = {
  hp: 20,
  maxHp: 20,
  position: { x: 0, y: 0 },
  level: 1,
};

/** Tools registered with handlers that read/mutate world state. */
const STATEFUL_TOOLS = new Set(['status', 'look', 'act']);

function textAnd<T extends Record<string, unknown>>(
  structured: T,
): { content: Array<{ type: 'text'; text: string }>; structuredContent: T } {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

/**
 * Apply an `act` intent to the world. Only the intents the bundled
 * verification scenarios need are modelled; everything else is an accepted
 * no-op so a real model poking at the fake doesn't get spurious errors.
 */
function applyAct(
  state: FakeWorldState,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const intent = String(args.intent ?? '');
  switch (intent) {
    case 'move': {
      const dx = Number(args.dx ?? 0) || 0;
      const dy = Number(args.dy ?? 0) || 0;
      state.position = { x: state.position.x + dx, y: state.position.y + dy };
      return { ok: true, intent, position: state.position };
    }
    case 'attack': {
      const dmg = Number(args.damage ?? 5) || 5;
      // Model the *target's* HP loss as a returned field; the character's own
      // HP is left intact (the bundled scenario asserts the move, not combat
      // math — combat scenarios land with #674).
      return { ok: true, intent, damageDealt: dmg };
    }
    default:
      return { ok: true, intent };
  }
}

/**
 * Build a stateful fake geas-server linked to a `GeasMcpClient` over an
 * in-memory transport. Returns a {@link VerifyWorld} the harness drives.
 */
export async function createFakeWorld(
  initial: Partial<FakeWorldState> = {},
): Promise<VerifyWorld> {
  const state: FakeWorldState = {
    ...DEFAULT_STATE,
    ...initial,
    position: { ...DEFAULT_STATE.position, ...(initial.position ?? {}) },
  };

  const server = new McpServer({
    name: 'fake-geas-server (verify)',
    version: '0.0.1',
  });

  const statusSnapshot = () =>
    textAnd({
      ok: true,
      hp: state.hp,
      maxHp: state.maxHp,
      position: state.position,
      level: state.level,
    });

  for (const name of GEAS_TOOL_NAMES) {
    const description = STATEFUL_TOOLS.has(name)
      ? `stateful fake ${name}`
      : `fake ${name}`;

    // `act` is the only tool whose behaviour depends on its arguments — and
    // the MCP SDK only forwards arguments to the handler when the tool
    // declares an input schema (without one, the handler's first param is the
    // request `extra`, not the args). So register `act` with a schema; every
    // other tool takes no args and gets the bare registration.
    if (name === 'act') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (server as any).registerTool(
        name,
        {
          title: name,
          description,
          inputSchema: {
            intent: z.string(),
            dx: z.number().optional(),
            dy: z.number().optional(),
            damage: z.number().optional(),
          },
        },
        async (args: Record<string, unknown>) => textAnd(applyAct(state, args)),
      );
      continue;
    }

    const handler =
      name === 'status' || name === 'look'
        ? async () => statusSnapshot()
        : async () => textAnd({ ok: true, name });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).registerTool(name, { title: name, description }, handler);
  }

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
  if (!conn.ok) {
    throw new Error(`fake-world MCP connect: ${conn.error.message}`);
  }

  let closed = false;
  return {
    kind: 'fake',
    client,
    async seed(patch: WorldSeed): Promise<void> {
      if (patch.hp !== undefined) state.hp = patch.hp;
      if (patch.maxHp !== undefined) state.maxHp = patch.maxHp;
      if (patch.level !== undefined) state.level = patch.level;
      if (patch.position !== undefined) {
        state.position = { x: patch.position.x, y: patch.position.y };
      }
    },
    async snapshot(): Promise<WorldSnapshot> {
      return {
        hp: state.hp,
        maxHp: state.maxHp,
        position: { ...state.position },
        level: state.level,
      };
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await client.disconnect();
      await server.close();
    },
  };
}
