import { describe, it, expect } from 'vitest';
import { buildRecoveryPrompt } from './recovery.js';

describe('buildRecoveryPrompt', () => {
  it('echoes the failed tool, args, and reason', () => {
    const out = buildRecoveryPrompt({
      failure: {
        toolName: 'look',
        args: { radius: 'not-a-number' },
        reason: "wrong type for 'radius': expected number, got string",
      },
      priorIntent: 'scout north for goblins',
    });
    expect(out).toContain('`look`');
    expect(out).toContain('"radius":"not-a-number"');
    expect(out).toContain("wrong type for 'radius'");
  });

  it('surfaces the prior intent verbatim when present', () => {
    const out = buildRecoveryPrompt({
      failure: {
        toolName: 'act',
        args: {},
        reason: "missing required argument 'intents'",
      },
      priorIntent: 'attack the goblin at (520,400)',
    });
    expect(out).toContain('"attack the goblin at (520,400)"');
    expect(out).toMatch(/do not repeat the failed call/i);
  });

  it('trims whitespace from the prior intent when surfacing it', () => {
    const out = buildRecoveryPrompt({
      failure: { toolName: 'look', args: {}, reason: 'tool_error: x' },
      priorIntent: '   scout north   ',
    });
    expect(out).toContain('"scout north"');
    expect(out).not.toContain('"   scout');
  });

  it('nudges the model to declare an intent when priorIntent is null', () => {
    const out = buildRecoveryPrompt({
      failure: { toolName: 'look', args: {}, reason: 'tool_error: x' },
      priorIntent: null,
    });
    expect(out).toMatch(/did not declare an Intent/i);
    expect(out).toMatch(/Intent:\s*<one line>/);
    expect(out).not.toMatch(/prior intent was/i);
  });

  it('treats an empty / whitespace prior intent the same as null', () => {
    const out = buildRecoveryPrompt({
      failure: { toolName: 'look', args: {}, reason: 'tool_error: x' },
      priorIntent: '   ',
    });
    expect(out).toMatch(/did not declare an Intent/i);
  });

  it('truncates very long arg JSON to keep the prompt small', () => {
    const huge = 'x'.repeat(2000);
    const out = buildRecoveryPrompt({
      failure: {
        toolName: 'act',
        args: { payload: huge },
        reason: 'tool_error: too big',
      },
      priorIntent: 'do the thing',
    });
    expect(out).toMatch(/truncated/);
    // Sanity: the full 2000-char payload was not echoed in full.
    expect(out.length).toBeLessThan(2000);
  });

  it('handles unserializable args without throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const out = buildRecoveryPrompt({
      failure: {
        toolName: 'act',
        args: circular,
        reason: 'tool_error: x',
      },
      priorIntent: 'do the thing',
    });
    expect(out).toContain('<unserializable args>');
  });
});
