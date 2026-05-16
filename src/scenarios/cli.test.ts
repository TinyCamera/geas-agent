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
