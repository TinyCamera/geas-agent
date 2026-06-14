/**
 * `combat` verification scenario (#674).
 *
 * "Kill 3 goblins." Seed three goblins adjacent to the character, drive the
 * agent to attack until all three are dead, then assert the kill count. This
 * is the agent-side analogue of `kipp`'s goblin-hunt smoke: it proves the
 * whole stack (user message → model → `act`/attack dispatch → server mutation)
 * resolves a combat objective.
 *
 * Under the default keyless harness the `noopScript` issues three `attack`
 * intents (one kill each) and a closing narration. Against a real model the
 * script is ignored and the model decides for itself.
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

export const combat: VerifyScenario = {
  name: 'combat',
  description:
    'Seed three adjacent goblins, ask the agent to kill them, assert 3 dead.',
  noopScript: [
    attackTurn('atk-1'),
    attackTurn('atk-2'),
    attackTurn('atk-3'),
    {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'All three goblins are dead.' }],
    },
  ],
  async setup(world) {
    await world.seed({
      hp: 30,
      maxHp: 30,
      position: { x: 5, y: 5 },
      level: 2,
      enemies: [
        { id: 'gob-1', name: 'goblin', x: 5, y: 6, hp: 5 },
        { id: 'gob-2', name: 'goblin', x: 6, y: 5, hp: 5 },
        { id: 'gob-3', name: 'goblin', x: 4, y: 5, hp: 5 },
      ],
    });
  },
  script: [
    {
      userMessage: 'Kill the three goblins around you.',
      expectedEvents: [
        { type: 'tool-call', tool: 'act' },
        { type: 'tool-result', tool: 'act', status: 'ok' },
        { type: 'narration', includes: 'goblins' },
        { type: 'done' },
      ],
    },
  ],
  async asserts({ snapshot }) {
    const kills = Number(snapshot.kills);
    if (kills !== 3) {
      throw new Error(`expected 3 kills, got ${String(snapshot.kills)}`);
    }
    const alive = Number(snapshot.enemiesAlive);
    if (alive !== 0) {
      throw new Error(`expected 0 goblins alive, got ${String(snapshot.enemiesAlive)}`);
    }
  },
};
