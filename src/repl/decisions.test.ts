/**
 * Unit tests for the decision-event renderer + input parser (issue #649).
 */

import { describe, expect, it } from 'vitest';
import {
  applyDecisionInput,
  parseNumber,
  parsePayload,
  renderInitialPrompt,
  serializeChoice,
  serializeTimeout,
  type DecisionState,
} from './decisions.js';

describe('parsePayload', () => {
  it('recognises level_up with options array', () => {
    const p = parsePayload({
      kind: 'level_up',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B', description: 'd' },
      ],
    });
    expect(p.kind).toBe('level_up');
    expect(p.options).toHaveLength(2);
    expect(p.options[1]).toEqual({
      id: 'b',
      label: 'B',
      description: 'd',
      detail: undefined,
    });
  });

  it('falls back to unknown kind without crashing', () => {
    const p = parsePayload({ kind: 'mystery', options: [{ id: 'x', label: 'X' }] });
    expect(p.kind).toBe('unknown');
    expect(p.rawKind).toBe('mystery');
    expect(p.options).toHaveLength(1);
  });

  it('tolerates a completely malformed payload', () => {
    const p = parsePayload(null);
    expect(p.kind).toBe('unknown');
    expect(p.options).toEqual([]);
  });

  it('supplies default stats for character_creation', () => {
    const p = parsePayload({
      kind: 'character_creation',
      options: [{ id: 'warrior', label: 'Warrior' }],
    });
    expect(p.kind).toBe('character_creation');
    expect(p.stats?.length).toBeGreaterThan(0);
    expect(p.statBudget).toBeGreaterThan(0);
  });

  it('reads deadlineMs when present', () => {
    const p = parsePayload({
      kind: 'level_up',
      options: [{ id: 'a', label: 'A' }],
      deadlineMs: 5000,
    });
    expect(p.deadlineMs).toBe(5000);
  });
});

describe('parseNumber', () => {
  it('accepts plain digits', () => expect(parseNumber('3')).toBe(3));
  it('accepts trailing dot', () => expect(parseNumber('3.')).toBe(3));
  it('accepts surrounding whitespace', () => expect(parseNumber('  4 ')).toBe(4));
  it('rejects letters', () => expect(parseNumber('3a')).toBe(null));
  it('rejects empty', () => expect(parseNumber('')).toBe(null));
});

describe('renderInitialPrompt', () => {
  it('renders level_up with numbered options', () => {
    const { lines, state } = renderInitialPrompt('d1', {
      kind: 'level_up',
      options: [
        { id: 'p', label: 'Power Strike', description: 'STR +2' },
        { id: 'b', label: 'Block' },
      ],
    });
    expect(lines[0]).toBe('Level up — pick one:');
    expect(lines[1]).toBe('  [1] Power Strike — STR +2');
    expect(lines[2]).toBe('  [2] Block');
    expect(state.kind).toBe('simple');
  });

  it('renders build_picker', () => {
    const { lines } = renderInitialPrompt('d2', {
      kind: 'build_picker',
      options: [{ id: 'rogue', label: 'Rogue' }],
    });
    expect(lines[0]).toBe('Choose your build:');
  });

  it('renders unknown kind with a generic header', () => {
    const { lines } = renderInitialPrompt('d3', {
      kind: 'weird-modal',
      options: [{ id: 'a', label: 'Aye' }],
    });
    expect(lines[0]).toContain('weird-modal');
    expect(lines[1]).toBe('  [1] Aye');
  });

  it('renders empty-options decision without crashing', () => {
    const { lines } = renderInitialPrompt('d4', { kind: 'level_up', options: [] });
    expect(lines.join('\n')).toContain('(no options');
  });

  it('renders character_creation in stats phase', () => {
    const { lines, state } = renderInitialPrompt('d5', {
      kind: 'character_creation',
      options: [{ id: 'mage', label: 'Mage' }],
    });
    expect(lines[0]).toMatch(/Character creation/);
    expect(state.kind).toBe('character_creation');
    if (state.kind === 'character_creation') {
      expect(state.stage).toBe('stats');
    }
  });
});

describe('applyDecisionInput — simple', () => {
  const state: DecisionState = {
    kind: 'simple',
    decisionId: 'd-7',
    parsed: parsePayload({
      kind: 'level_up',
      options: [
        { id: 'power', label: 'Power' },
        { id: 'block', label: 'Block' },
      ],
    }),
  };

  it('accepts a valid number and returns the optionId', () => {
    const r = applyDecisionInput(state, '2');
    expect(r.kind).toBe('select');
    if (r.kind === 'select') expect(r.optionId).toBe('block');
  });

  it('rejects non-numeric input but does not crash', () => {
    const r = applyDecisionInput(state, 'hello');
    expect(r.kind).toBe('invalid');
  });

  it('rejects out-of-range', () => {
    const r = applyDecisionInput(state, '99');
    expect(r.kind).toBe('invalid');
  });

  it('handles q for cancel', () => {
    expect(applyDecisionInput(state, 'q').kind).toBe('cancel');
    expect(applyDecisionInput(state, 'quit').kind).toBe('cancel');
    expect(applyDecisionInput(state, 'cancel').kind).toBe('cancel');
  });
});

describe('applyDecisionInput — character_creation flow', () => {
  function makeState(): DecisionState {
    const { state } = renderInitialPrompt('d-cc', {
      kind: 'character_creation',
      stats: [
        { id: 'STR', label: 'Strength', min: 1, max: 10 },
        { id: 'AGI', label: 'Agility', min: 1, max: 10 },
      ],
      statBudget: 10,
      options: [
        { id: 'warrior', label: 'Warrior' },
        { id: 'rogue', label: 'Rogue' },
      ],
    });
    return state;
  }

  it('walks stats → done → build → select envelope', () => {
    let s = makeState();
    let r = applyDecisionInput(s, '5');
    expect(r.kind).toBe('stat-progress');
    if (r.kind === 'stat-progress') s = r.nextState;

    r = applyDecisionInput(s, '4');
    expect(r.kind).toBe('stat-progress');
    if (r.kind === 'stat-progress') s = r.nextState;

    // All stats set — type "done" to advance to build.
    r = applyDecisionInput(s, 'done');
    expect(r.kind).toBe('stat-progress');
    if (r.kind === 'stat-progress') s = r.nextState;
    if (s.kind === 'character_creation') {
      expect(s.stage).toBe('build');
    }

    r = applyDecisionInput(s, '1');
    expect(r.kind).toBe('select');
    if (r.kind === 'select') {
      const parsed = JSON.parse(r.optionId) as {
        stats: Record<string, number>;
        build: string;
      };
      expect(parsed.build).toBe('warrior');
      expect(parsed.stats).toEqual({ STR: 5, AGI: 4 });
    }
  });

  it('rejects over-budget stat allocation', () => {
    let s = makeState();
    let r = applyDecisionInput(s, '8');
    expect(r.kind).toBe('stat-progress');
    if (r.kind === 'stat-progress') s = r.nextState;
    r = applyDecisionInput(s, '5'); // 8+5=13 > 10 budget
    expect(r.kind).toBe('invalid');
  });

  it('rejects below-min stat value', () => {
    const s = makeState();
    const r = applyDecisionInput(s, '0');
    expect(r.kind).toBe('invalid');
  });

  it('reset returns to empty stat state', () => {
    let s = makeState();
    let r = applyDecisionInput(s, '5');
    if (r.kind === 'stat-progress') s = r.nextState;
    r = applyDecisionInput(s, '4');
    if (r.kind === 'stat-progress') s = r.nextState;
    r = applyDecisionInput(s, 'reset');
    expect(r.kind).toBe('stat-progress');
    if (r.kind === 'stat-progress' && r.nextState.kind === 'character_creation') {
      expect(r.nextState.statValues).toEqual({});
      expect(r.nextState.stage).toBe('stats');
    }
  });
});

describe('serialization', () => {
  it('serializeChoice is just the optionId', () => {
    expect(serializeChoice({ optionId: 'power' })).toBe('power');
  });
  it('serializeTimeout returns a JSON envelope', () => {
    expect(JSON.parse(serializeTimeout())).toEqual({ timeout: true });
  });
});
