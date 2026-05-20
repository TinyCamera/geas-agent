/**
 * CLI parsing tests. Pure-function coverage — we don't exec the cli; the
 * `main()` orchestration is covered by the integration run.
 */

import { describe, it, expect } from 'vitest';

import { parseCliOptions } from './cli.js';

describe('parseCliOptions', () => {
  it('requires a scenario name', () => {
    const r = parseCliOptions([], {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.exitCode).toBe(3);
      expect(r.message).toMatch(/usage/);
    }
  });

  it('requires GEAS_MCP_URL', () => {
    const r = parseCliOptions(['goblin-hunt'], {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.exitCode).toBe(2);
      expect(r.message).toMatch(/GEAS_MCP_URL/);
    }
  });

  // Regression: #631 — the GEAS_MCP_URL error message had a missing closing
  // paren in an earlier draft. Asserting the exact format keeps it from
  // drifting again, and the "balanced parens" check below catches the same
  // class of typo in any other parser error string we add later.
  it('GEAS_MCP_URL error message is well-formed (closing paren present)', () => {
    const r = parseCliOptions(['goblin-hunt'], {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toBe(
        'GEAS_MCP_URL is required (e.g. http://localhost:8088/mcp)',
      );
    }
  });

  it('all parser error messages have balanced parentheses', () => {
    // Drive every error branch in parseCliOptions and assert each message has
    // matching `(` / `)` counts. Cheap audit that catches the #631 typo class.
    const cases: Array<{ argv: string[]; env: NodeJS.ProcessEnv }> = [
      { argv: [], env: {} }, // missing scenario name
      { argv: ['goblin-hunt'], env: {} }, // missing GEAS_MCP_URL
      {
        argv: ['goblin-hunt'],
        env: { GEAS_MCP_URL: 'x', GEAS_SCENARIO_TIMEOUT: '0' },
      }, // bad timeout
      {
        argv: ['goblin-hunt'],
        env: { GEAS_MCP_URL: 'x', GEAS_SCENARIO_TIMEOUT: 'not-a-number' },
      }, // non-numeric timeout
    ];
    for (const c of cases) {
      const r = parseCliOptions(c.argv, c.env);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const opens = (r.message.match(/\(/g) ?? []).length;
        const closes = (r.message.match(/\)/g) ?? []).length;
        expect(opens, `unbalanced parens in: ${r.message}`).toBe(closes);
      }
    }
  });

  it('parses a happy path with defaults', () => {
    const r = parseCliOptions(['goblin-hunt'], {
      GEAS_MCP_URL: 'http://localhost:8088/mcp',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.scenarioName).toBe('goblin-hunt');
      expect(r.options.url).toBe('http://localhost:8088/mcp');
      expect(r.options.devUid).toBe('scenario-runner');
      expect(r.options.timeoutMs).toBe(120_000);
      expect(r.options.bearerToken).toBeUndefined();
    }
  });

  it('honours overrides from env', () => {
    const r = parseCliOptions(['goblin-hunt'], {
      GEAS_MCP_URL: 'https://prod/mcp',
      GEAS_DEV_UID: 'niall-dev',
      GEAS_BEARER_TOKEN: 'tok',
      GEAS_SCENARIO_CHAR: 'BoboTheTester',
      GEAS_SCENARIO_TIMEOUT: '60',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.devUid).toBe('niall-dev');
      expect(r.options.bearerToken).toBe('tok');
      expect(r.options.characterName).toBe('BoboTheTester');
      expect(r.options.timeoutMs).toBe(60_000);
    }
  });

  it('rejects a non-positive timeout', () => {
    const r = parseCliOptions(['goblin-hunt'], {
      GEAS_MCP_URL: 'x',
      GEAS_SCENARIO_TIMEOUT: '0',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.exitCode).toBe(3);
  });
});
