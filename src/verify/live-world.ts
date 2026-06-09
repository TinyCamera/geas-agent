/**
 * Live geas-server adapter for the verification harness (#673).
 *
 * Connects a real {@link GeasMcpClient} at `GEAS_LIVE_MCP_URL` so the harness
 * can run a verification scenario against an actual running geas-server with a
 * real LLM provider — the "end-to-end with a real LLM + real geas-server
 * fixture" leg of #673's acceptance. It is the live counterpart to
 * {@link './fake-world.js'.createFakeWorld}.
 *
 * **Seeding is best-effort.** A live server's world is authoritative; seeding
 * relies on the dev-only tools (`set_position`, `set_hp`, …) that geas-server
 * registers under `GEAS_DEV_UNAUTH=1`. When a field can't be seeded the world
 * warns rather than throws — the standard live scenarios (#674) drive setup
 * through the agent itself where possible. `snapshot()` derives state from the
 * `status` tool's `structuredContent`.
 */

import { GeasMcpClient } from '../mcp/index.js';
import type { VerifyWorld, WorldSeed, WorldSnapshot } from './types.js';

export interface LiveWorldOptions {
  readonly url: string;
  readonly devUid?: string;
  readonly bearerToken?: string;
  readonly onWarning?: (message: string, detail?: unknown) => void;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Pull a `{x,y}` from common geas-server position shapes. */
function readPosition(s: Record<string, unknown>): WorldSnapshot['position'] {
  const p = (s.position ?? s.pos) as Record<string, unknown> | undefined;
  if (p && num(p.x) !== undefined && num(p.y) !== undefined) {
    return { x: p.x as number, y: p.y as number };
  }
  if (num(s.x) !== undefined && num(s.y) !== undefined) {
    return { x: s.x as number, y: s.y as number };
  }
  return undefined;
}

/** Connect to a live geas-server and return a {@link VerifyWorld}. */
export async function createLiveWorld(
  opts: LiveWorldOptions,
): Promise<VerifyWorld> {
  const warn =
    opts.onWarning ??
    ((m: string, d?: unknown) => console.warn(`[verify][live] ${m}`, d ?? ''));
  const client = new GeasMcpClient({
    url: opts.url,
    ...(opts.devUid ? { devUid: opts.devUid } : {}),
    ...(opts.bearerToken ? { bearerToken: opts.bearerToken } : {}),
    onWarning: warn,
  });
  const conn = await client.connect();
  if (!conn.ok) {
    throw new Error(
      `live-world MCP connect (${opts.url}): ${conn.error.kind} — ${conn.error.message}`,
    );
  }

  let closed = false;
  return {
    kind: `live:${opts.url}`,
    client,
    async seed(patch: WorldSeed): Promise<void> {
      if (patch.position) {
        const r = await client.callTool('set_position', {
          x: patch.position.x,
          y: patch.position.y,
        });
        if (!r.ok) warn(`seed position failed: ${r.error.message}`);
      }
      if (patch.hp !== undefined) {
        const r = await client.callTool('set_hp', { hp: patch.hp });
        if (!r.ok) warn(`seed hp failed: ${r.error.message}`);
      }
    },
    async snapshot(): Promise<WorldSnapshot> {
      const r = await client.callTool('status');
      if (!r.ok) {
        warn(`status failed: ${r.error.message}`);
        return {};
      }
      const s = (r.value.structuredContent ?? {}) as Record<string, unknown>;
      const position = readPosition(s);
      return {
        ...s,
        ...(num(s.hp) !== undefined ? { hp: s.hp as number } : {}),
        ...(num(s.maxHp) !== undefined ? { maxHp: s.maxHp as number } : {}),
        ...(num(s.level) !== undefined ? { level: s.level as number } : {}),
        ...(position ? { position } : {}),
      };
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await client.disconnect();
    },
  };
}
