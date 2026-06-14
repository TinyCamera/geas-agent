/**
 * `levelup` verification scenario (#674).
 *
 * Seed the character just below an XP threshold with a killable goblin in
 * range, then drive: fight → kill → cross the threshold → allocate stats →
 * choose a level-up reward. Asserts the level rose and both post-level-up
 * steps (stat allocation, skill choice) landed — the ordering the game
 * requires (allocate before choose, see geas-server MCP guidance).
 *
 * The keyless `noopScript` walks the full sequence deterministically; a real
 * model is handed the same world and decides the tool order itself.
 */

import type { VerifyScenario } from '../types.js';

export const levelup: VerifyScenario = {
  name: 'levelup',
  description:
    'Seed XP just below threshold, fight to level, allocate stats, choose a reward.',
  noopScript: [
    // Kill the goblin — pushes XP over the threshold, triggers a level-up.
    {
      stopReason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'lvl-atk', name: 'act', input: { intent: 'attack' } },
      ],
    },
    // Allocate stats first (the game only offers level-up picks once stats are set).
    {
      stopReason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'lvl-alloc',
          name: 'allocate_stats',
          input: { str: 1 },
        },
      ],
    },
    // Then choose the level-up reward.
    {
      stopReason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'lvl-choose',
          name: 'choose_levelup',
          input: { choice: 'skill' },
        },
      ],
    },
    {
      stopReason: 'end_turn',
      content: [
        { type: 'text', text: 'Leveled up — allocated stats and chose a skill.' },
      ],
    },
  ],
  async setup(world) {
    await world.seed({
      hp: 30,
      maxHp: 30,
      position: { x: 0, y: 0 },
      level: 2,
      xp: 90,
      xpToNext: 100,
      enemies: [{ id: 'gob-xp', name: 'goblin', x: 0, y: 1, hp: 5 }],
    });
  },
  script: [
    {
      userMessage: 'Fight until you level up, then spend the level.',
      expectedEvents: [
        { type: 'tool-call', tool: 'act' },
        { type: 'tool-call', tool: 'allocate_stats' },
        { type: 'tool-call', tool: 'choose_levelup' },
        { type: 'done' },
      ],
    },
  ],
  async asserts({ snapshot }) {
    const level = Number(snapshot.level);
    if (level <= 2) {
      throw new Error(`expected level > 2 after fight, got ${String(snapshot.level)}`);
    }
    if (snapshot.statsAllocated !== true) {
      throw new Error('expected stats to be allocated after level-up');
    }
    if (snapshot.skillChosen !== true) {
      throw new Error('expected a level-up reward to be chosen');
    }
    if (snapshot.pendingLevelUp !== false) {
      throw new Error('expected the pending level-up to be resolved');
    }
  },
};
