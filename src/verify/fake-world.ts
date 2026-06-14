/**
 * In-memory stateful fake geas-server for the verification harness (#673,
 * extended for the standard scenario set in #674).
 *
 * **Why a *stateful* fake.** The fake MCP server the `GeasMcpClient` unit
 * tests use (`src/index-server.test.ts`) registers every tool as a benign
 * `{ok:true}` stub — fine for proving the wiring composes, useless for a
 * verification scenario whose whole point is "drive the agent, then assert the
 * *world changed*". This fake keeps a tiny mutable world (HP, position, level,
 * XP, enemies, a point-of-interest) so a scenario's `act` actually moves /
 * fights and `asserts` can observe it — all deterministic, in-process, no
 * network, no LLM, no keys.
 *
 * **Coverage of the tool surface.** Every name in {@link GEAS_TOOL_NAMES} is
 * registered (the wrapper's connect-time drift check requires it). Most return
 * a benign `{ok:true}`; the *stateful* set reflects / mutates the world:
 *
 *   - `status` / `look` — project the live world.
 *   - `act` — `move` shifts position; `attack` resolves combat against the
 *     nearest in-range enemy (kill → XP → maybe level-up), and returns a tool
 *     error when the target is out of range (drives the `stuck` scenario).
 *   - `allocate_stats` / `choose_levelup` — resolve a pending level-up.
 *   - `nearest` — surfaces the seeded point-of-interest (drives `nav`).
 *
 * Unknown `act` intents are accepted as no-op `{ok:true}` so a real-LLM run
 * against this fake degrades gracefully rather than erroring. When no enemies
 * are seeded at all, `attack` is also a benign no-op (back-compat with the
 * `smoke` scenario, which never fights).
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

/** One enemy the fake combat model tracks. */
interface FakeEnemy {
  id: string;
  name: string;
  x: number;
  y: number;
  hp: number;
}

/** A point-of-interest the agent can navigate toward. */
interface FakePoi {
  name: string;
  x: number;
  y: number;
}

/** The mutable world the fake server owns. */
interface FakeWorldState {
  hp: number;
  maxHp: number;
  position: { x: number; y: number };
  level: number;
  /** XP accumulated toward the next level. */
  xp: number;
  /** XP threshold for the next level. */
  xpToNext: number;
  /** Set when a kill crosses the threshold; cleared by `choose_levelup`. */
  pendingLevelUp: boolean;
  /** Set by `allocate_stats`. */
  statsAllocated: boolean;
  /** Set by `choose_levelup` while a level-up is pending. */
  skillChosen: boolean;
  /** Living + dead enemies (dead ones keep `hp <= 0`). */
  enemies: FakeEnemy[];
  /** Cumulative kills this session. */
  kills: number;
  /** The navigation target, when one is seeded. */
  poi: FakePoi | null;
}

const DEFAULT_STATE: FakeWorldState = {
  hp: 20,
  maxHp: 20,
  position: { x: 0, y: 0 },
  level: 1,
  xp: 0,
  xpToNext: 100,
  pendingLevelUp: false,
  statsAllocated: false,
  skillChosen: false,
  enemies: [],
  kills: 0,
  poi: null,
};

/** Manhattan/Chebyshev reach for a melee `attack`. */
const ATTACK_RANGE = 1;
/** Damage a bare `attack` deals when none is supplied. */
const DEFAULT_DAMAGE = 5;
/** XP granted per kill. */
const XP_PER_KILL = 50;

/** Tools whose handlers read or mutate world state. */
const STATEFUL_TOOLS = new Set([
  'status',
  'look',
  'act',
  'allocate_stats',
  'choose_levelup',
  'nearest',
]);

function textAnd<T extends Record<string, unknown>>(
  structured: T,
): { content: Array<{ type: 'text'; text: string }>; structuredContent: T } {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

/**
 * A tool-reported error. `GeasMcpClient.callTool` maps `isError: true` to a
 * `kind:'tool_error'` `Result` Err — the agent loop then treats it as a failed
 * tool call (retry / stuck-detector input).
 */
function textErr(
  reason: string,
): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: reason }) }],
    isError: true,
  };
}

const chebyshev = (
  a: { x: number; y: number },
  b: { x: number; y: number },
): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

const aliveEnemies = (state: FakeWorldState): FakeEnemy[] =>
  state.enemies.filter((e) => e.hp > 0);

/** Award XP for a kill and promote levels while the threshold is crossed. */
function grantKillXp(state: FakeWorldState): void {
  state.kills += 1;
  state.xp += XP_PER_KILL;
  while (state.xp >= state.xpToNext) {
    state.xp -= state.xpToNext;
    state.level += 1;
    state.pendingLevelUp = true;
  }
}

/**
 * Apply an `act` intent to the world. Only the intents the bundled
 * verification scenarios need are modelled; everything else is an accepted
 * no-op so a real model poking at the fake doesn't get spurious errors.
 */
function applyAct(
  state: FakeWorldState,
  args: Record<string, unknown>,
): Record<string, unknown> | { isError: true; content: Array<{ type: 'text'; text: string }> } {
  const intent = String(args.intent ?? '');
  switch (intent) {
    case 'move': {
      const dx = Number(args.dx ?? 0) || 0;
      const dy = Number(args.dy ?? 0) || 0;
      state.position = { x: state.position.x + dx, y: state.position.y + dy };
      return { ok: true, intent, position: state.position };
    }
    case 'attack': {
      const living = aliveEnemies(state);
      // No enemies seeded → benign no-op (back-compat: `smoke` never fights).
      if (state.enemies.length === 0) {
        const dmg = Number(args.damage ?? DEFAULT_DAMAGE) || DEFAULT_DAMAGE;
        return { ok: true, intent, damageDealt: dmg };
      }
      // Target the nearest living enemy within range.
      const target = living
        .filter((e) => chebyshev(e, state.position) <= ATTACK_RANGE)
        .sort(
          (a, b) =>
            chebyshev(a, state.position) - chebyshev(b, state.position),
        )[0];
      if (!target) {
        // Living enemies exist but none in range → out-of-range error.
        return textErr('no target in range');
      }
      const dmg = Number(args.damage ?? DEFAULT_DAMAGE) || DEFAULT_DAMAGE;
      target.hp -= dmg;
      const killed = target.hp <= 0;
      if (killed) grantKillXp(state);
      return {
        ok: true,
        intent,
        target: target.id,
        damageDealt: dmg,
        killed,
        enemiesAlive: aliveEnemies(state).length,
      };
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
    enemies: (initial.enemies ?? DEFAULT_STATE.enemies).map((e) => ({ ...e })),
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
      xp: state.xp,
      kills: state.kills,
      pendingLevelUp: state.pendingLevelUp,
      enemiesAlive: aliveEnemies(state).length,
    });

  /** Hand-written stateful handlers for the tools that read/mutate the world. */
  const statefulHandler = (name: string): (() => ReturnType<typeof textAnd>) => {
    switch (name) {
      case 'allocate_stats':
        return () => {
          state.statsAllocated = true;
          return textAnd({ ok: true, statsAllocated: true, level: state.level });
        };
      case 'choose_levelup':
        return () => {
          if (state.pendingLevelUp) {
            state.skillChosen = true;
            state.pendingLevelUp = false;
            return textAnd({ ok: true, leveledUp: true, skillChosen: true });
          }
          return textAnd({ ok: true, leveledUp: false });
        };
      case 'nearest':
        return () =>
          textAnd({
            ok: true,
            kind: 'poi',
            name: state.poi?.name ?? 'nothing',
            position: state.poi ? { x: state.poi.x, y: state.poi.y } : null,
          });
      default:
        return statusSnapshot;
    }
  };

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
        async (args: Record<string, unknown>) => {
          const out = applyAct(state, args);
          // `applyAct` may return a tool-error envelope (out-of-range attack).
          return 'isError' in out ? out : textAnd(out);
        },
      );
      continue;
    }

    const handler =
      name === 'status' || name === 'look'
        ? async () => statusSnapshot()
        : STATEFUL_TOOLS.has(name)
          ? async () => statefulHandler(name)()
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
      if (patch.xp !== undefined) state.xp = Number(patch.xp);
      if (patch.xpToNext !== undefined) state.xpToNext = Number(patch.xpToNext);
      if (patch.enemies !== undefined) {
        const seeded = patch.enemies as ReadonlyArray<FakeEnemy>;
        state.enemies = seeded.map((e) => ({ ...e }));
        state.kills = 0;
      }
      if (patch.poi !== undefined) {
        const p = patch.poi as FakePoi | null;
        state.poi = p ? { name: p.name, x: p.x, y: p.y } : null;
      }
    },
    async snapshot(): Promise<WorldSnapshot> {
      return {
        hp: state.hp,
        maxHp: state.maxHp,
        position: { ...state.position },
        level: state.level,
        xp: state.xp,
        xpToNext: state.xpToNext,
        kills: state.kills,
        enemiesAlive: aliveEnemies(state).length,
        pendingLevelUp: state.pendingLevelUp,
        statsAllocated: state.statsAllocated,
        skillChosen: state.skillChosen,
        poi: state.poi ? { ...state.poi } : null,
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
