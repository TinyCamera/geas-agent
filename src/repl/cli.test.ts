/**
 * Unit tests for the REPL config + helper surface (#735).
 *
 * Covers the env-var paper-cuts:
 *   - GEAS_AGENT_TOKEN defaults to "dev-token" when unset, surfaces via
 *     `tokenIsDefault: true` so the REPL prints a warning on session start.
 *   - GEAS_AGENT_CHARACTER missing → throw with a multi-line help message
 *     that names the three escape hatches (--list, --new-character, env).
 *   - `extractCharacterId` finds the new id across the response shapes
 *     `create_character` is known to return (structuredContent.id /
 *     .characterId / .character.id / text-content JSON).
 */
import { describe, it, expect } from 'vitest';
import {
  readConfigFromEnv,
  extractCharacterId,
  MISSING_CHARACTER_HELP,
  DEFAULT_AGENT_TOKEN,
} from './cli.js';

describe('readConfigFromEnv', () => {
  it('defaults GEAS_AGENT_TOKEN to "dev-token" when unset and flags tokenIsDefault', () => {
    const cfg = readConfigFromEnv({ GEAS_AGENT_CHARACTER: 'char-1' });
    expect(cfg.token).toBe(DEFAULT_AGENT_TOKEN);
    expect(cfg.tokenIsDefault).toBe(true);
  });

  it('uses an explicit GEAS_AGENT_TOKEN as-is and leaves tokenIsDefault false', () => {
    const cfg = readConfigFromEnv({
      GEAS_AGENT_TOKEN: 'prod-secret',
      GEAS_AGENT_CHARACTER: 'char-1',
    });
    expect(cfg.token).toBe('prod-secret');
    expect(cfg.tokenIsDefault).toBe(false);
  });

  it('throws a helpful MISSING_CHARACTER_HELP when GEAS_AGENT_CHARACTER is unset', () => {
    expect(() => readConfigFromEnv({})).toThrow(MISSING_CHARACTER_HELP);
    // Snapshot the key phrases so docs and code can't drift silently.
    expect(MISSING_CHARACTER_HELP).toMatch(/GEAS_AGENT_CHARACTER is required/);
    expect(MISSING_CHARACTER_HELP).toMatch(/--list/);
    expect(MISSING_CHARACTER_HELP).toMatch(/--new-character/);
    expect(MISSING_CHARACTER_HELP).toMatch(/docs\/dev\.md/);
  });

  it('respects requireCharacter:false for the --new-character bootstrap path', () => {
    const cfg = readConfigFromEnv({}, { requireCharacter: false });
    expect(cfg.characterId).toBe('');
    expect(cfg.token).toBe(DEFAULT_AGENT_TOKEN);
  });

  it('defaults the base URL to http://127.0.0.1:8090 (matches server default)', () => {
    const cfg = readConfigFromEnv({ GEAS_AGENT_CHARACTER: 'c' });
    expect(cfg.baseUrl).toBe('http://127.0.0.1:8090');
  });
});

describe('extractCharacterId', () => {
  it('finds id at structuredContent.characterId', () => {
    expect(
      extractCharacterId({ structuredContent: { characterId: 'char-abc' } }),
    ).toBe('char-abc');
  });

  it('finds id at structuredContent.id', () => {
    expect(extractCharacterId({ structuredContent: { id: 'char-xyz' } })).toBe(
      'char-xyz',
    );
  });

  it('finds id under a nested .character wrap', () => {
    expect(
      extractCharacterId({
        structuredContent: { character: { id: 'char-nest', name: 'n' } },
      }),
    ).toBe('char-nest');
  });

  it('falls back to JSON inside a text content block', () => {
    expect(
      extractCharacterId({
        content: [
          { type: 'text', text: JSON.stringify({ characterId: 'char-txt' }) },
        ],
      }),
    ).toBe('char-txt');
  });

  it('returns null when no id is present', () => {
    expect(extractCharacterId({ structuredContent: { ok: true } })).toBeNull();
    expect(extractCharacterId({})).toBeNull();
  });

  it('ignores empty-string ids', () => {
    expect(extractCharacterId({ structuredContent: { id: '' } })).toBeNull();
  });
});
