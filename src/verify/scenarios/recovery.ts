/**
 * `recovery` verification scenario (#674).
 *
 * Broken-tool-call recovery. The first scripted turn issues a tool the server
 * doesn't expose (`act_move` — a plausible typo for `act`); the pre-dispatch
 * validator rejects it locally as `unknown_tool`, the retry layer surfaces the
 * failure, and the loop re-drives. The second turn issues the correct `act`
 * move and completes the task. Asserts the world actually moved — i.e. the
 * agent recovered rather than stalling on the bad call.
 *
 * This exercises the #586 validation/retry layer through the real loop: the
 * "wrong tool name" is the injected fault; recovery is the next round-trip.
 */

import type { VerifyScenario } from '../types.js';

export const recovery: VerifyScenario = {
  name: 'recovery',
  description:
    'First tool call uses a wrong tool name (validator-rejected); agent recovers and moves.',
  noopScript: [
    // Wrong tool name — the validator rejects this before any network round-trip.
    {
      stopReason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'rec-bad',
          name: 'act_move',
          input: { dx: 1, dy: 0 },
        },
      ],
    },
    // Corrected call — the real `act` move.
    {
      stopReason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'rec-good',
          name: 'act',
          input: { intent: 'move', dx: 1, dy: 0 },
        },
      ],
    },
    {
      stopReason: 'end_turn',
      content: [
        { type: 'text', text: 'Recovered from the bad tool call and moved east.' },
      ],
    },
  ],
  async setup(world) {
    await world.seed({ hp: 20, maxHp: 20, position: { x: 5, y: 5 }, level: 1 });
  },
  script: [
    {
      userMessage: 'Move one tile east.',
      expectedEvents: [
        { type: 'error' },
        { type: 'tool-result', tool: 'act', status: 'ok' },
        { type: 'narration', includes: 'Recovered' },
        { type: 'done' },
      ],
    },
  ],
  async asserts({ snapshot }) {
    const pos = snapshot.position;
    if (!pos || pos.x !== 6 || pos.y !== 5) {
      throw new Error(
        `expected recovery to land the move at (6,5), got ${
          pos ? `(${pos.x},${pos.y})` : 'no position'
        }`,
      );
    }
  },
};
