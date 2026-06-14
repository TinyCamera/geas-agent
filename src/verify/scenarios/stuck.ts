/**
 * `stuck` verification scenario (#674).
 *
 * Put an enemy out of attack range and ask the agent to attack it. Each
 * `attack` fails (the fake server returns a tool error: no target in range).
 * The stuck detector fires on the *second* identical failure — before the
 * retry budget exhausts — and the loop surfaces a `stuck` error to the user
 * instead of hammering the same broken call.
 *
 * Asserts no progress was made (no kills, character didn't move) and relies on
 * the per-turn `expectedEvents` to prove the `stuck` signal reached Channel A.
 */

import type { VerifyScenario } from '../types.js';

const attackTurn = (id: string) =>
  ({
    stopReason: 'tool_use' as const,
    content: [
      {
        type: 'tool_use' as const,
        id,
        name: 'act',
        input: { intent: 'attack' },
      },
    ],
  });

export const stuck: VerifyScenario = {
  name: 'stuck',
  description:
    'Attack an out-of-range enemy; the stuck detector fires on the repeat failure.',
  noopScript: [
    // Two identical out-of-range attacks: the second trips the stuck detector.
    attackTurn('stuck-1'),
    attackTurn('stuck-2'),
    {
      stopReason: 'end_turn',
      content: [
        {
          type: 'text',
          text: "I can't reach it — that enemy is out of range. I'm stuck and need your help.",
        },
      ],
    },
  ],
  async setup(world) {
    await world.seed({
      hp: 20,
      maxHp: 20,
      position: { x: 0, y: 0 },
      level: 1,
      // A single enemy far away — every attack is out of range.
      enemies: [{ id: 'troll', name: 'troll', x: 10, y: 10, hp: 40 }],
    });
  },
  script: [
    {
      userMessage: 'Attack the troll across the room.',
      expectedEvents: [
        { type: 'tool-call', tool: 'act' },
        { type: 'error', includes: 'stuck' },
        { type: 'narration', includes: 'stuck' },
        { type: 'done' },
      ],
    },
  ],
  async asserts({ snapshot }) {
    if (Number(snapshot.kills) !== 0) {
      throw new Error(`expected 0 kills while stuck, got ${String(snapshot.kills)}`);
    }
    const pos = snapshot.position;
    if (!pos || pos.x !== 0 || pos.y !== 0) {
      throw new Error(
        `expected no movement while stuck, got ${
          pos ? `(${pos.x},${pos.y})` : 'no position'
        }`,
      );
    }
  },
};
