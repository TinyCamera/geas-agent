/**
 * goblin-hunt scenario unit tests.
 *
 * Uses a hand-rolled stub of `GeasMcpClient`'s methods (just the few the
 * scenario actually calls) — wiring up an in-memory MCP server with full state
 * would be a 200-line integration test, but the scenario's logic (find target,
 * threshold-retreat, return to spawn) is straightforward to drive with a
 * scripted stub.
 */

import { describe, it, expect } from 'vitest';

import { goblinHunt } from './goblin-hunt.js';
import { createBufferLogger } from './logger.js';
import { createBinding } from '../binding/index.js';
import { ok, type GeasToolResponse, type Result } from '../mcp/index.js';
import type { GeasMcpClient } from '../mcp/index.js';

interface StubPlayer {
  gridX: number;
  gridY: number;
  health: number;
  maxHealth: number;
  isAlive: boolean;
  inCombat: boolean;
}

interface StubGoblin {
  id: string;
  gridX: number;
  gridY: number;
  alive: boolean;
}

interface StubScript {
  player: StubPlayer;
  goblin: StubGoblin | null;
  /** Per-attack: how much damage we take, and how much damage we deal. */
  onAttack: () => { takeDamage: number; dealDamage: number };
}

function structuredResp(structured: Record<string, unknown>): GeasToolResponse {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

function makeStubClient(script: StubScript): {
  client: GeasMcpClient;
  calls: { tool: string; args?: unknown }[];
} {
  const calls: { tool: string; args?: unknown }[] = [];
  const stub = {
    async status(): Promise<Result<GeasToolResponse>> {
      calls.push({ tool: 'status' });
      const p = script.player;
      return ok(
        structuredResp({
          gridX: p.gridX,
          gridY: p.gridY,
          health: p.health,
          maxHealth: p.maxHealth,
          isAlive: p.isAlive,
          inCombat: p.inCombat,
        }),
      );
    },
    async entities(args: unknown): Promise<Result<GeasToolResponse>> {
      calls.push({ tool: 'entities', args });
      const g = script.goblin;
      if (!g || !g.alive) {
        return ok(structuredResp({ entities: [] }));
      }
      return ok(
        structuredResp({
          entities: [
            {
              id: g.id,
              entityType: 'ENEMY',
              spriteKey: 'goblin',
              displayName: 'Test Goblin',
              gridX: g.gridX,
              gridY: g.gridY,
              distance:
                Math.abs(g.gridX - script.player.gridX) +
                Math.abs(g.gridY - script.player.gridY),
              isAlive: true,
              isBoss: false,
            },
          ],
        }),
      );
    },
    async act(args: unknown): Promise<Result<GeasToolResponse>> {
      calls.push({ tool: 'act', args });
      // Inspect the intent to decide effect.
      const intents = (args as { intents?: Array<{ kind: string }> })?.intents ?? [];
      const kind = intents[0]?.kind ?? 'unknown';
      if (kind === 'attack') {
        const { takeDamage, dealDamage } = script.onAttack();
        script.player.health = Math.max(0, script.player.health - takeDamage);
        if (script.goblin) {
          // crude: goblin dies after `dealDamage` total >= 100 (caller controls)
          (script.goblin as StubGoblin & { hp?: number }).hp =
            ((script.goblin as StubGoblin & { hp?: number }).hp ?? 100) - dealDamage;
          if (((script.goblin as StubGoblin & { hp?: number }).hp ?? 0) <= 0) {
            script.goblin.alive = false;
          }
        }
        return ok(
          structuredResp({
            results: [{ status: 'ok', outcome: 'hit' }],
          }),
        );
      }
      if (kind === 'move') {
        const tgt = (intents[0] as { target?: { x: number; y: number } }).target;
        if (tgt) {
          script.player.gridX = tgt.x;
          script.player.gridY = tgt.y;
        }
        return ok(structuredResp({ results: [{ status: 'ok', outcome: 'moved' }] }));
      }
      return ok(structuredResp({ results: [{ status: 'ok' }] }));
    },
  };
  return { client: stub as unknown as GeasMcpClient, calls };
}

const binding = createBinding({
  entityId: 'e-test',
  ownerUid: 'u-test',
  bindingMode: 'agent-only',
});

describe('goblinHunt scenario', () => {
  it('kills a goblin and returns to spawn', async () => {
    const script: StubScript = {
      player: { gridX: 50, gridY: 50, health: 100, maxHealth: 100, isAlive: true, inCombat: true },
      goblin: { id: 'g1', gridX: 52, gridY: 50, alive: true },
      onAttack: () => ({ takeDamage: 5, dealDamage: 60 }), // 2 hits to kill (60 + 60 > 100)
    };
    const { client, calls } = makeStubClient(script);
    const log = createBufferLogger();
    // Walk the player a bit off-spawn between status calls — simulate movement
    // during combat by mutating after the first attack.
    let attacksSeen = 0;
    const origAttack = script.onAttack;
    script.onAttack = () => {
      attacksSeen++;
      if (attacksSeen === 1) {
        script.player.gridX = 52; // pulled into range by autoApproach
      }
      return origAttack();
    };
    await goblinHunt({ client, binding, logger: log });
    // Goblin died.
    expect(script.goblin?.alive).toBe(false);
    // Return-to-spawn move was issued.
    const moveCall = calls.find(
      (c) =>
        c.tool === 'act' &&
        (c.args as { intents?: Array<{ kind: string }> })?.intents?.[0]?.kind === 'move',
    );
    expect(moveCall).toBeTruthy();
    expect((moveCall!.args as { intents: Array<{ target: { x: number; y: number } }> }).intents[0].target)
      .toEqual({ x: 50, y: 50 });
    // Logger captured the kill-assumption.
    expect(log.entries.some((e) => /kill assumed/.test(e.message))).toBe(true);
  });

  it('retreats when HP drops below 30%', async () => {
    const script: StubScript = {
      player: { gridX: 10, gridY: 10, health: 100, maxHealth: 100, isAlive: true, inCombat: true },
      goblin: { id: 'g1', gridX: 12, gridY: 10, alive: true },
      // Each "attack" we take 40 damage, deal only 5 — goblin stays alive, HP crashes.
      onAttack: () => ({ takeDamage: 40, dealDamage: 5 }),
    };
    const { client, calls } = makeStubClient(script);
    const log = createBufferLogger();
    await goblinHunt({ client, binding, logger: log });
    expect(script.goblin?.alive).toBe(true); // didn't kill it
    expect(script.player.health).toBeLessThan(30); // crossed retreat threshold
    expect(log.entries.some((e) => /retreating/i.test(e.message))).toBe(true);
    // Should still attempt return-to-spawn (player is at original position so it skips).
    // Player never actually moved in stub, so the runner sees pos == spawn → no move issued.
    const moveCall = calls.find(
      (c) =>
        c.tool === 'act' &&
        (c.args as { intents?: Array<{ kind: string }> })?.intents?.[0]?.kind === 'move',
    );
    expect(moveCall).toBeUndefined();
  });

  it('exits cleanly when no goblin is visible', async () => {
    const script: StubScript = {
      player: { gridX: 5, gridY: 5, health: 100, maxHealth: 100, isAlive: true, inCombat: false },
      goblin: null,
      onAttack: () => ({ takeDamage: 0, dealDamage: 0 }),
    };
    const { client, calls } = makeStubClient(script);
    const log = createBufferLogger();
    await goblinHunt({ client, binding, logger: log });
    // No attack calls — went straight from nearest-miss to clean exit.
    expect(calls.filter((c) => c.tool === 'act').length).toBe(0);
    expect(log.entries.some((e) => /no goblin/i.test(e.message))).toBe(true);
  });

  it('throws when scenario starts on a dead character', async () => {
    const script: StubScript = {
      player: { gridX: 0, gridY: 0, health: 0, maxHealth: 100, isAlive: false, inCombat: false },
      goblin: null,
      onAttack: () => ({ takeDamage: 0, dealDamage: 0 }),
    };
    const { client } = makeStubClient(script);
    const log = createBufferLogger();
    await expect(goblinHunt({ client, binding, logger: log })).rejects.toThrow(/dead/);
  });
});
