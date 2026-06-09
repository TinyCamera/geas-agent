/**
 * `smoke` — the harness self-test scenario (#673).
 *
 * The trivial end-to-end the ticket's acceptance asks for: seed a known
 * position, tell the agent to move, and assert the world actually moved. Under
 * the default `NoopProvider` the model's two round-trips are scripted (a `move`
 * `act` call, then a closing narration) so the run is deterministic and needs
 * no API key — this is the scenario the CI self-test and `npm run test:verify`
 * exercise. Under a real provider the `noopScript` is ignored and the model
 * decides for itself; the same `asserts` still apply.
 *
 * It deliberately exercises the full pipeline — setup → LLM turn → tool
 * dispatch → server mutation → assert on server state → report — so a
 * regression anywhere in the harness (or a drift in the loop/runner contract)
 * breaks this scenario loudly.
 */

import type { VerifyScenario } from '../types.js';

export const smoke: VerifyScenario = {
  name: 'smoke',
  description:
    'Seed a position, ask the agent to move east, assert the world moved.',
  noopScript: [
    // Turn 1: the model decides to call `act` with a move intent.
    {
      stopReason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'call-move-1',
          name: 'act',
          input: { intent: 'move', dx: 1, dy: 0 },
        },
      ],
    },
    // Turn 2: with the tool result in context, the model narrates and ends.
    {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'Moved one tile east as requested.' }],
    },
  ],
  async setup(world) {
    await world.seed({ hp: 30, maxHp: 30, position: { x: 5, y: 5 }, level: 2 });
  },
  script: [
    {
      userMessage: 'Move one tile east.',
      expectedEvents: [
        { type: 'tool-call', tool: 'act' },
        { type: 'tool-result', tool: 'act', status: 'ok' },
        { type: 'narration', includes: 'Moved' },
        { type: 'done' },
      ],
    },
  ],
  async asserts({ snapshot }) {
    const pos = snapshot.position;
    if (!pos) throw new Error('no position in world snapshot');
    if (pos.x !== 6 || pos.y !== 5) {
      throw new Error(
        `expected position (6,5) after move east, got (${pos.x},${pos.y})`,
      );
    }
    if (snapshot.hp !== 30) {
      throw new Error(`expected hp unchanged at 30, got ${snapshot.hp}`);
    }
  },
};
