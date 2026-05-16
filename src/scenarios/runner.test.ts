/**
 * Runner + registry unit tests.
 *
 * No real client — scenarios under test are inline functions that just touch
 * the logger so we can assert on the runner's contract (timing, ok/err, missing
 * scenario, propagated errors) without spinning up MCP. The goblin-hunt
 * scenario itself has dedicated tests with a stub client.
 */

import { describe, it, expect } from 'vitest';

import {
  runScenario,
  ScenarioNotFoundError,
} from './runner.js';
import { createScenarioRegistry } from './registry.js';
import { createBufferLogger } from './logger.js';
import type { Scenario } from './types.js';
import { createBinding } from '../binding/index.js';
import { GeasMcpClient } from '../mcp/index.js';

// Minimal fake client — we only need the runner contract, not real wire calls.
function fakeClient(): GeasMcpClient {
  return {} as unknown as GeasMcpClient;
}

const binding = createBinding({
  entityId: 'e-test',
  ownerUid: 'u-test',
  bindingMode: 'agent-only',
});

describe('runScenario', () => {
  it('runs a registered scenario and returns ok', async () => {
    const noop: Scenario = async ({ logger }) => {
      logger.info('hello from noop');
    };
    const reg = createScenarioRegistry([
      { name: 'noop', description: 'no-op scenario', run: noop },
    ]);
    const log = createBufferLogger();
    const result = await runScenario('noop', reg, {
      client: fakeClient(),
      binding,
      logger: log,
    });
    expect(result.ok).toBe(true);
    expect(result.scenario).toBe('noop');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(log.entries.some((e) => e.message.includes('hello from noop'))).toBe(true);
    expect(log.entries.some((e) => e.message.includes('starting'))).toBe(true);
    expect(log.entries.some((e) => e.message.includes('completed'))).toBe(true);
  });

  it('returns ok=false with the thrown message when the scenario throws', async () => {
    const boom: Scenario = async () => {
      throw new Error('kaboom');
    };
    const reg = createScenarioRegistry([
      { name: 'boom', description: 'throws', run: boom },
    ]);
    const log = createBufferLogger();
    const result = await runScenario('boom', reg, {
      client: fakeClient(),
      binding,
      logger: log,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('kaboom');
    expect(log.entries.some((e) => e.level === 'error')).toBe(true);
  });

  it('returns ok=false with a typed not-found error when the name misses', async () => {
    const reg = createScenarioRegistry([]);
    const result = await runScenario('missing', reg, {
      client: fakeClient(),
      binding,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.cause).toBeInstanceOf(ScenarioNotFoundError);
    expect(result.error?.message).toMatch(/unknown scenario/);
  });

  it('throws when client or binding is missing — those are programmer errors', async () => {
    const reg = createScenarioRegistry([]);
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runScenario('whatever', reg, { binding } as any),
    ).rejects.toThrow(/client/);
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runScenario('whatever', reg, { client: fakeClient() } as any),
    ).rejects.toThrow(/binding/);
  });

  it('passes the AbortSignal through to the scenario', async () => {
    let saw: AbortSignal | undefined;
    const peek: Scenario = async ({ signal }) => {
      saw = signal;
    };
    const reg = createScenarioRegistry([
      { name: 'peek', description: 'records signal', run: peek },
    ]);
    const ctrl = new AbortController();
    await runScenario('peek', reg, {
      client: fakeClient(),
      binding,
      signal: ctrl.signal,
      logger: createBufferLogger(),
    });
    expect(saw).toBe(ctrl.signal);
  });
});

describe('createScenarioRegistry', () => {
  it('rejects duplicate names', () => {
    const dup: Scenario = async () => {};
    expect(() =>
      createScenarioRegistry([
        { name: 'a', description: 'one', run: dup },
        { name: 'a', description: 'two', run: dup },
      ]),
    ).toThrow(/duplicate/);
  });

  it('exposes the default goblin-hunt scenario in SCENARIOS', () => {
    const reg = createScenarioRegistry();
    expect(reg.has('goblin-hunt')).toBe(true);
  });
});
