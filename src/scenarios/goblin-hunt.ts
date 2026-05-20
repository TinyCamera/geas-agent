/**
 * goblin-hunt — the smoke-test scenario for the agent harness.
 *
 * Flow:
 *   1. `status` to learn current position + HP. This is also our "spawn point"
 *      reference — we treat wherever the character is at scenario start as the
 *      point to return to at the end. Rationale: `whoami` / `status` don't
 *      expose a stored spawn coordinate today; querying it would mean a new
 *      server tool (out of scope for #582). "Start position == spawn" is a
 *      defensible smoke-test choice; the LLM-driven loop in later epics can
 *      query the real spawn once one is exposed.
 *
 *   2. `nearest({type:'goblin'})` to find a target.
 *
 *   3. `act({intents: [{kind:'attack', targetEntityId, autoApproach: true}]})`
 *      until the goblin dies OR our HP drops below 30% of max. `autoApproach`
 *      lets the server path us into range — we don't need to issue a separate
 *      `move` first (the move/attack chord is the agent.md-recommended pattern).
 *
 *   4. Re-`status` between attacks to read updated HP and combat state.
 *
 *   5. After resolution (kill or retreat), issue a `move` back to the recorded
 *      spawn coordinates.
 *
 * Out of scope (later epics):
 *   - Retry / stuck detection if `act` returns `partial` for many consecutive
 *     ticks (#590-ish).
 *   - LLM-driven decision-making.
 *   - Multi-target / threat management.
 */

import type { Scenario } from './types.js';
import { structured, unwrap, sleep } from './util.js';

interface PlayerState {
  gridX: number;
  gridY: number;
  health: number;
  maxHealth: number;
  isAlive: boolean;
  inCombat: boolean;
}

interface EnemyHit {
  id: string;
  entityType?: string;
  spriteKey?: string;
  displayName?: string;
  gridX?: number;
  gridY?: number;
  distance?: number;
  isAlive?: boolean;
  isBoss?: boolean;
}

interface EntitiesResponse {
  entities?: EnemyHit[];
}

interface ActResponse {
  results?: Array<{ status?: string; outcome?: string; reason?: string; tag?: string }>;
  stoppedAt?: number;
}

const MAX_COMBAT_ROUNDS = 40; // Hard cap; a fresh character usually downs a goblin in <15.
const RETREAT_HP_FRACTION = 0.3;
const ACTION_PAUSE_MS = 200; // Brief breather so the server's tick (20 Hz) advances between calls.
const POST_TELEPORT_SETTLE_MS = 600; // ChunkManager activates new chunks on the next world tick;
                                     // give it a few ticks to populate before re-asking for entities.

/**
 * #632 — fallback teleport target when the spawn fog is empty.
 *
 * Bramble Hollow (the canonical village spawn) lives at world-tile
 * (544, 608) in Heartlands which has no hostile spawns. The Wilds
 * region (cy 4..7, i.e. world y in roughly [256, 512)) is the closest
 * goblin-bearing band — every Wilds chunk seeds ~3 enemies including
 * goblins (see geas-server `REGION_SPAWN_CONFIGS.WILDS`).
 *
 * Hardcoded coords are deliberate for v1: the scenario already hardcodes
 * "spawn position == Bramble Hollow" in its return-to-spawn step, and
 * the canonical world layout is part of the same #418/#420 contract
 * these coordinates pin against. If the world layout drifts, the live
 * integration test in `tests/integration/` will catch it.
 */
const HUNT_TELEPORT_X = 544; // Same column as Bramble Hollow.
const HUNT_TELEPORT_Y = 460; // ~150 tiles north — deep enough into the Wilds
                             // band that the fog radius doesn't straddle Heartlands.

async function readPlayerState(
  client: Parameters<Scenario>[0]['client'],
): Promise<PlayerState> {
  const resp = unwrap('status', await client.status());
  const s = structured<Record<string, unknown>>(resp);
  if (!s) throw new Error('status returned no structuredContent');
  return {
    gridX: numberField(s, 'gridX'),
    gridY: numberField(s, 'gridY'),
    health: numberField(s, 'health'),
    maxHealth: numberField(s, 'maxHealth'),
    isAlive: s.isAlive !== false,
    inCombat: s.inCombat === true,
  };
}

async function findGoblins(
  client: Parameters<Scenario>[0]['client'],
): Promise<EnemyHit[]> {
  const resp = unwrap(
    'entities(ENEMY)',
    await client.entities({ type: 'ENEMY', aliveOnly: true, excludeBoss: true }),
  );
  const data = structured<EntitiesResponse>(resp);
  return (data?.entities ?? []).filter(
    (e) => e.spriteKey === 'goblin' && e.isAlive !== false && !e.isBoss,
  );
}

function numberField(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`status: expected numeric "${key}", got ${JSON.stringify(v)}`);
  }
  return v;
}

export const goblinHunt: Scenario = async ({ client, logger, signal }) => {
  // -- 1. spawn snapshot ---------------------------------------------------
  const spawn = await readPlayerState(client);
  logger.info(
    `spawn snapshot: pos=(${spawn.gridX},${spawn.gridY}) hp=${spawn.health}/${spawn.maxHealth}`,
  );
  if (!spawn.isAlive) {
    throw new Error('character is dead at scenario start; cannot hunt');
  }

  // -- 2. find a goblin -----------------------------------------------------
  // The server's `nearest` / `entities` filter is by EntityType enum (ENEMY,
  // NPC, …), not by sprite/template. So we ask for the nearest ENEMY list and
  // post-filter on `spriteKey === 'goblin'`. (`nearest` returns at most one
  // entity, which might be an orc; pulling the whole enemy list and filtering
  // is cheap inside the fog radius.)
  let goblins = await findGoblins(client);
  if (goblins.length === 0) {
    // #632 — the canonical fresh-stack spawn is Bramble Hollow village
    // center, which lives in Heartlands and has NO hostile spawns. The
    // old behaviour ("scenario ends idle (success)") was a hollow green
    // for a scenario named "goblin-hunt". Use the dev-only `set_position`
    // teleport to drop into the Wilds and resume the hunt.
    if (typeof client.hasTool === 'function' && client.hasTool('set_position')) {
      logger.info(
        `no goblin in fog-of-war range from spawn — teleporting to (${HUNT_TELEPORT_X},${HUNT_TELEPORT_Y}) (Wilds) via set_position`,
      );
      const tpResp = await client.setPosition({ x: HUNT_TELEPORT_X, y: HUNT_TELEPORT_Y });
      if (!tpResp.ok) {
        throw new Error(
          `set_position failed: ${tpResp.error.kind} — ${tpResp.error.message}`,
        );
      }
      // Let ChunkManager activate the destination chunks before re-asking.
      await sleep(POST_TELEPORT_SETTLE_MS, signal);
      goblins = await findGoblins(client);
      if (goblins.length === 0) {
        throw new Error(
          `no goblin in fog-of-war range after teleport to (${HUNT_TELEPORT_X},${HUNT_TELEPORT_Y}); ` +
            'the Wilds region should always have goblins. Check geas-server REGION_SPAWN_CONFIGS / world seed.',
        );
      }
    } else {
      // Without the dev tool we have no clean way to get within fog of a
      // goblin from village center (the closest goblin band is ~100+
      // tiles away — too far for a deterministic walk). Surface as a
      // real failure rather than a hollow success.
      throw new Error(
        'no goblin in fog-of-war range, and set_position is not available — ' +
          'is geas-server running with GEAS_DEV_UNAUTH=1? ' +
          'See geas-agent/docs/dev.md for the local-stack setup.',
      );
    }
  }
  // Sort by Manhattan distance ascending; server already attaches `distance`.
  goblins.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
  const hit = goblins[0]!;
  logger.info(
    `target: ${hit.displayName ?? hit.spriteKey ?? 'goblin'} ${hit.id} at (${hit.gridX},${hit.gridY}) dist=${hit.distance}`,
  );

  // -- 3 / 4. attack loop ---------------------------------------------------
  const targetId = hit.id;
  let lastOutcome: 'killed' | 'retreated' | 'gave-up' = 'gave-up';
  for (let round = 0; round < MAX_COMBAT_ROUNDS; round++) {
    if (signal?.aborted) throw new Error('aborted');

    // Drain events + check own HP before swinging.
    const me = await readPlayerState(client);
    const hpFraction = me.maxHealth > 0 ? me.health / me.maxHealth : 0;
    logger.info(
      `round ${round + 1}: hp=${me.health}/${me.maxHealth} (${(hpFraction * 100).toFixed(0)}%) inCombat=${me.inCombat}`,
    );
    if (!me.isAlive) {
      logger.warn('character died mid-fight; aborting hunt');
      lastOutcome = 'retreated';
      break;
    }
    if (hpFraction < RETREAT_HP_FRACTION) {
      logger.warn(
        `hp below ${RETREAT_HP_FRACTION * 100}% threshold (${me.health}/${me.maxHealth}); retreating`,
      );
      lastOutcome = 'retreated';
      break;
    }

    const actResp = unwrap(
      'act/attack',
      await client.act({
        intent: 'unused', // ActArgs.intent is a permissive holdover; real surface is `intents`.
        intents: [
          { kind: 'attack', targetEntityId: targetId, autoApproach: true, tag: `r${round}` },
        ],
      }),
    );
    const data = structured<ActResponse>(actResp);
    const result = data?.results?.[0];
    logger.info(
      `act result: status=${result?.status ?? '?'} outcome=${result?.outcome ?? '?'} reason=${result?.reason ?? ''}`,
    );

    // Probe — `entities(ENEMY, aliveOnly)` only returns living enemies; if our
    // target id is gone from the list it's either dead or out of fog. Either
    // way "this target" is resolved.
    const probeResp = unwrap(
      'entities probe',
      await client.entities({ type: 'ENEMY', aliveOnly: true, excludeBoss: true }),
    );
    const probeData = structured<EntitiesResponse>(probeResp);
    const stillAlive = (probeData?.entities ?? []).some((e) => e.id === targetId);
    if (!stillAlive) {
      logger.info(`target ${targetId} no longer in live-enemy list — kill assumed`);
      lastOutcome = 'killed';
      break;
    }

    await sleep(ACTION_PAUSE_MS, signal);
  }
  if (lastOutcome === 'gave-up') {
    logger.warn(`combat did not resolve within ${MAX_COMBAT_ROUNDS} rounds`);
  }

  // -- 5. return to spawn ---------------------------------------------------
  // Out of combat, `move` paths us using A*. Errors here are not fatal to the
  // scenario goal — log + continue rather than throw.
  const post = await readPlayerState(client);
  if (post.gridX === spawn.gridX && post.gridY === spawn.gridY) {
    logger.info('already at spawn; no return move needed');
    return;
  }
  logger.info(
    `returning to spawn from (${post.gridX},${post.gridY}) -> (${spawn.gridX},${spawn.gridY})`,
  );
  const returnResp = await client.act({
    intent: 'unused',
    intents: [{ kind: 'move', target: { x: spawn.gridX, y: spawn.gridY }, tag: 'return' }],
  });
  if (!returnResp.ok) {
    logger.warn(`return-to-spawn act failed: ${returnResp.error.kind} — ${returnResp.error.message}`);
  } else {
    const data = structured<ActResponse>(returnResp.value);
    logger.info(
      `return move dispatched: status=${data?.results?.[0]?.status ?? '?'} (server pathing async; not waiting for arrival)`,
    );
  }
};
