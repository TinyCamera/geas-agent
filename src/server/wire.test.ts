import { describe, expect, it } from 'vitest';
import {
  DECISION_RESPONSE_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  type BuildPickerDecisionPayload,
  type BuildPickerDecisionResponse,
  type CharacterCreationDecisionPayload,
  type CharacterCreationDecisionResponse,
  type DecisionEvent,
  type DecisionPayload,
  type DecisionResponse,
  type LevelUpDecisionPayload,
  type LevelUpDecisionResponse,
  decodeDecisionResponse,
  encodeDecisionResponse,
  isDecisionPayload,
  isDecisionResponse,
} from './wire.js';

/**
 * Issue #697 — wire contract for decision events between agent and client.
 * Exhaustive type narrowing + JSON round-trip for each variant.
 */

const LEVEL_UP_PAYLOAD: LevelUpDecisionPayload = {
  kind: 'level_up',
  options: [
    { id: 'power-strike', label: 'Power Strike', description: '+2 melee dmg' },
    { id: 'block', label: 'Shield Block', detail: { tag: 'defensive' } },
  ],
  deadlineMs: 1_700_000_000_000,
};

const BUILD_PICKER_PAYLOAD: BuildPickerDecisionPayload = {
  kind: 'build_picker',
  options: [
    { id: 'mage', label: 'Mage' },
    { id: 'warrior', label: 'Warrior' },
  ],
  suggestedIndex: 0,
};

const CHARACTER_CREATION_PAYLOAD: CharacterCreationDecisionPayload = {
  kind: 'character_creation',
  options: [
    { id: 'warrior', label: 'Warrior' },
    { id: 'rogue', label: 'Rogue' },
  ],
  stats: [
    { id: 'STR', label: 'Strength', min: 1, max: 10 },
    { id: 'AGI', label: 'Agility', min: 1, max: 10 },
  ],
  statBudget: 12,
};

describe('DecisionEvent payload types — exhaustive narrowing', () => {
  it('narrows the discriminated union without falling through', () => {
    const samples: readonly DecisionPayload[] = [
      LEVEL_UP_PAYLOAD,
      BUILD_PICKER_PAYLOAD,
      CHARACTER_CREATION_PAYLOAD,
    ];
    const seen: string[] = [];
    for (const p of samples) {
      // Exhaustiveness: omitting any case makes the `never` line a type error.
      switch (p.kind) {
        case 'level_up':
          seen.push(p.kind);
          break;
        case 'build_picker':
          seen.push(p.kind);
          break;
        case 'character_creation':
          seen.push(p.kind);
          break;
        default: {
          const _exhaustive: never = p;
          throw new Error(`unhandled: ${JSON.stringify(_exhaustive)}`);
        }
      }
    }
    expect(seen).toEqual(['level_up', 'build_picker', 'character_creation']);
  });

  it('attaches cleanly to a DecisionEvent envelope', () => {
    const ev: DecisionEvent = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'decision',
      eventId: 7,
      ts: 1_700_000_000_000,
      uid: 'u',
      characterId: 'c',
      decisionId: 'd-1',
      payload: LEVEL_UP_PAYLOAD,
    };
    expect(isDecisionPayload(ev.payload)).toBe(true);
  });
});

describe('isDecisionPayload', () => {
  it.each<[string, DecisionPayload]>([
    ['level_up', LEVEL_UP_PAYLOAD],
    ['build_picker', BUILD_PICKER_PAYLOAD],
    ['character_creation', CHARACTER_CREATION_PAYLOAD],
  ])('accepts a valid %s payload', (_label, payload) => {
    expect(isDecisionPayload(payload)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['array', []],
    ['unknown kind', { kind: 'inventory', options: [] }],
    ['missing options', { kind: 'level_up' }],
    ['non-array options', { kind: 'level_up', options: 'nope' }],
    ['string', 'level_up'],
  ])('rejects %s', (_label, bad) => {
    expect(isDecisionPayload(bad)).toBe(false);
  });
});

describe('DecisionResponse — round-trip via encode/decode', () => {
  const LEVEL_UP: LevelUpDecisionResponse = {
    kind: 'level_up',
    optionId: 'power-strike',
  };
  const BUILD_PICKER: BuildPickerDecisionResponse = {
    kind: 'build_picker',
    optionId: 'mage',
  };
  const CHARACTER_CREATION: CharacterCreationDecisionResponse = {
    kind: 'character_creation',
    name: 'Gimli',
    stats: { STR: 8, AGI: 4 },
    buildId: 'warrior',
  };

  it.each<[string, DecisionResponse]>([
    ['level_up', LEVEL_UP],
    ['build_picker', BUILD_PICKER],
    ['character_creation', CHARACTER_CREATION],
  ])('round-trips a %s response', (_label, response) => {
    const encoded = encodeDecisionResponse(response);
    expect(typeof encoded).toBe('string');
    const decoded = decodeDecisionResponse(encoded);
    expect(decoded).toEqual(response);
  });

  it('stamps the current schemaVersion onto the envelope', () => {
    const encoded = encodeDecisionResponse(LEVEL_UP);
    const raw = JSON.parse(encoded) as { schemaVersion: number };
    expect(raw.schemaVersion).toBe(DECISION_RESPONSE_SCHEMA_VERSION);
  });

  it('returns null for non-envelope text (legacy free-text reply)', () => {
    expect(decodeDecisionResponse('hello')).toBeNull();
    expect(decodeDecisionResponse('power-strike')).toBeNull();
    expect(decodeDecisionResponse('{')).toBeNull();
  });

  it('returns null on a schemaVersion mismatch', () => {
    const bad = JSON.stringify({
      schemaVersion: 999,
      response: LEVEL_UP,
    });
    expect(decodeDecisionResponse(bad)).toBeNull();
  });

  it('returns null when the inner response is malformed', () => {
    const bad = JSON.stringify({
      schemaVersion: DECISION_RESPONSE_SCHEMA_VERSION,
      response: { kind: 'level_up' /* no optionId */ },
    });
    expect(decodeDecisionResponse(bad)).toBeNull();
  });
});

describe('isDecisionResponse', () => {
  it('rejects unknown kind', () => {
    expect(isDecisionResponse({ kind: 'inventory', optionId: 'x' })).toBe(false);
  });

  it('rejects character_creation with non-number stat', () => {
    expect(
      isDecisionResponse({
        kind: 'character_creation',
        name: 'X',
        stats: { STR: 'eight' },
        buildId: 'warrior',
      }),
    ).toBe(false);
  });

  it('rejects character_creation with missing fields', () => {
    expect(
      isDecisionResponse({
        kind: 'character_creation',
        name: 'X',
        stats: { STR: 8 },
        // no buildId
      }),
    ).toBe(false);
  });
});
