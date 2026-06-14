/**
 * `nav` verification scenario (#674).
 *
 * "Go to the blacksmith." Seed a point-of-interest a few tiles away, then
 * drive the agent to locate it (`nearest` + `map`) and walk there with `act`
 * move intents. Asserts the character arrived at the POI tile within the
 * loop's turn budget.
 *
 * The keyless `noopScript` discovers the POI, consults the map, then issues
 * the exact moves to close the gap. A real model gets the same world and
 * navigates on its own.
 */

import type { VerifyScenario } from '../types.js';

const BLACKSMITH = { x: 2, y: 0 } as const;

const moveEast = (id: string) =>
  ({
    stopReason: 'tool_use' as const,
    content: [
      {
        type: 'tool_use' as const,
        id,
        name: 'act',
        input: { intent: 'move', dx: 1, dy: 0 },
      },
    ],
  });

export const nav: VerifyScenario = {
  name: 'nav',
  description:
    'Seed a blacksmith POI, ask the agent to walk there, assert arrival.',
  noopScript: [
    {
      stopReason: 'tool_use',
      content: [{ type: 'tool_use', id: 'nav-near', name: 'nearest', input: {} }],
    },
    {
      stopReason: 'tool_use',
      content: [{ type: 'tool_use', id: 'nav-map', name: 'map', input: {} }],
    },
    moveEast('nav-mv-1'),
    moveEast('nav-mv-2'),
    {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'Arrived at the blacksmith.' }],
    },
  ],
  async setup(world) {
    await world.seed({
      hp: 20,
      maxHp: 20,
      position: { x: 0, y: 0 },
      level: 1,
      poi: { name: 'blacksmith', x: BLACKSMITH.x, y: BLACKSMITH.y },
    });
  },
  script: [
    {
      userMessage: 'Go to the blacksmith.',
      expectedEvents: [
        { type: 'tool-call', tool: 'nearest' },
        { type: 'tool-call', tool: 'map' },
        { type: 'tool-call', tool: 'act' },
        { type: 'done' },
      ],
    },
  ],
  async asserts({ snapshot }) {
    const pos = snapshot.position;
    if (!pos || pos.x !== BLACKSMITH.x || pos.y !== BLACKSMITH.y) {
      throw new Error(
        `expected arrival at blacksmith (${BLACKSMITH.x},${BLACKSMITH.y}), got ${
          pos ? `(${pos.x},${pos.y})` : 'no position'
        }`,
      );
    }
  },
};
