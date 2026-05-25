import { describe, it, expect } from 'vitest';
import {
  PLAN_THEN_ACT_INSTRUCTIONS,
  composeSystemPrompt,
} from './system.js';

describe('PLAN_THEN_ACT_INSTRUCTIONS', () => {
  it('mentions the Intent: prefix the parser keys off', () => {
    // Guard against future editorial drift: if someone renames the prefix
    // here without updating intent.ts the parser silently misses every
    // intent. Keep the contract pinned via test.
    expect(PLAN_THEN_ACT_INSTRUCTIONS).toContain('Intent:');
  });

  it('documents the explicit-absent "Intent: none" escape hatch', () => {
    expect(PLAN_THEN_ACT_INSTRUCTIONS).toMatch(/Intent:\s*none/i);
  });

  it('is trimmed (no leading/trailing whitespace) so it composes cleanly', () => {
    expect(PLAN_THEN_ACT_INSTRUCTIONS).toBe(PLAN_THEN_ACT_INSTRUCTIONS.trim());
  });
});

describe('composeSystemPrompt', () => {
  it('appends protocol after a non-empty persona, separated by a blank line', () => {
    const out = composeSystemPrompt('You are a level-1 ranger.');
    expect(out.startsWith('You are a level-1 ranger.')).toBe(true);
    expect(out.endsWith(PLAN_THEN_ACT_INSTRUCTIONS)).toBe(true);
    expect(out).toContain('\n\n');
  });

  it('returns just the protocol when persona is blank', () => {
    expect(composeSystemPrompt('')).toBe(PLAN_THEN_ACT_INSTRUCTIONS);
    expect(composeSystemPrompt('   \n\t  ')).toBe(PLAN_THEN_ACT_INSTRUCTIONS);
  });

  it('trims the persona before composing', () => {
    const out = composeSystemPrompt('  Persona text.  \n');
    expect(out.startsWith('Persona text.')).toBe(true);
    expect(out).not.toMatch(/^\s/);
  });
});
