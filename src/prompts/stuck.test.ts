import { describe, it, expect } from 'vitest';
import {
  createStuckDetector,
  hashArgs,
  type ToolCallRecord,
} from './stuck.js';

const fail = (tool: string, args: unknown): ToolCallRecord => ({
  tool,
  args,
  status: 'fail',
});
const ok = (tool: string, args: unknown): ToolCallRecord => ({
  tool,
  args,
  status: 'ok',
});

describe('hashArgs', () => {
  it('produces equal hashes for key-order-permuted objects', () => {
    expect(hashArgs({ a: 1, b: 2 })).toBe(hashArgs({ b: 2, a: 1 }));
  });

  it('recurses into nested objects', () => {
    expect(hashArgs({ a: { x: 1, y: 2 } })).toBe(
      hashArgs({ a: { y: 2, x: 1 } }),
    );
  });

  it('preserves array order (semantically significant)', () => {
    expect(hashArgs([1, 2, 3])).not.toBe(hashArgs([3, 2, 1]));
  });

  it('differentiates different scalar values', () => {
    expect(hashArgs({ targetEntityId: 'goblin-1' })).not.toBe(
      hashArgs({ targetEntityId: 'goblin-2' }),
    );
  });

  it('coerces undefined / function values to null rather than throwing', () => {
    expect(() => hashArgs({ a: undefined, b: () => 1 })).not.toThrow();
    expect(hashArgs({ a: undefined })).toBe(hashArgs({ a: null }));
  });

  it('coerces bigint to its string form', () => {
    expect(hashArgs({ n: 10n })).toBe(hashArgs({ n: '10' }));
  });
});

describe('createStuckDetector', () => {
  it('does not fire on the first failure', () => {
    const d = createStuckDetector();
    expect(d.record(fail('act', { kind: 'attack', targetEntityId: 'g1' }))).toBeNull();
    expect(d.lastFailure).toEqual({
      tool: 'act',
      argsHash: hashArgs({ kind: 'attack', targetEntityId: 'g1' }),
    });
  });

  it('fires on the second identical failure', () => {
    const d = createStuckDetector();
    const args = { kind: 'attack', targetEntityId: 'g1' };
    d.record(fail('act', args));
    const signal = d.record(fail('act', args));
    expect(signal).not.toBeNull();
    expect(signal!.tool).toBe('act');
    expect(signal!.argsHash).toBe(hashArgs(args));
    expect(signal!.consecutiveFailures).toBe(2);
  });

  it('fires with monotonic counter on each subsequent identical failure', () => {
    const d = createStuckDetector();
    const args = { kind: 'attack', targetEntityId: 'g1' };
    d.record(fail('act', args));
    expect(d.record(fail('act', args))!.consecutiveFailures).toBe(2);
    expect(d.record(fail('act', args))!.consecutiveFailures).toBe(3);
    expect(d.record(fail('act', args))!.consecutiveFailures).toBe(4);
  });

  it('treats key-order-permuted args as identical', () => {
    const d = createStuckDetector();
    d.record(fail('act', { kind: 'attack', targetEntityId: 'g1' }));
    const signal = d.record(fail('act', { targetEntityId: 'g1', kind: 'attack' }));
    expect(signal).not.toBeNull();
    expect(signal!.consecutiveFailures).toBe(2);
  });

  it('does not fire when only the tool name differs', () => {
    const d = createStuckDetector();
    d.record(fail('act', { kind: 'attack', targetEntityId: 'g1' }));
    expect(d.record(fail('look', { kind: 'attack', targetEntityId: 'g1' }))).toBeNull();
  });

  it('does not fire when only the args differ', () => {
    const d = createStuckDetector();
    d.record(fail('act', { kind: 'attack', targetEntityId: 'g1' }));
    expect(d.record(fail('act', { kind: 'attack', targetEntityId: 'g2' }))).toBeNull();
  });

  it('resets after a successful call (no stuck across a success)', () => {
    const d = createStuckDetector();
    const args = { kind: 'attack', targetEntityId: 'g1' };
    d.record(fail('act', args));
    d.record(ok('look', {}));
    expect(d.lastFailure).toBeNull();
    // First failure after success — chain restarts, no signal.
    expect(d.record(fail('act', args))).toBeNull();
  });

  it('resets on onUserMessage()', () => {
    const d = createStuckDetector();
    const args = { kind: 'attack', targetEntityId: 'g1' };
    d.record(fail('act', args));
    d.onUserMessage();
    expect(d.lastFailure).toBeNull();
    expect(d.record(fail('act', args))).toBeNull();
  });

  it('resets on explicit reset()', () => {
    const d = createStuckDetector();
    const args = { kind: 'attack', targetEntityId: 'g1' };
    d.record(fail('act', args));
    d.record(fail('act', args)); // stuck
    d.reset();
    expect(d.lastFailure).toBeNull();
    expect(d.record(fail('act', args))).toBeNull();
  });

  it('only the most recent failure pair matters — non-adjacent identical fails do not fire', () => {
    const d = createStuckDetector();
    const argsA = { kind: 'attack', targetEntityId: 'g1' };
    const argsB = { kind: 'attack', targetEntityId: 'g2' };
    d.record(fail('act', argsA));
    expect(d.record(fail('act', argsB))).toBeNull();
    // argsA fails again, but the previous failure was argsB — not stuck.
    expect(d.record(fail('act', argsA))).toBeNull();
  });

  // Simulated agent-loop scenario: spec calls this the "integration" test.
  // We drive the detector through a scripted sequence equivalent to an
  // attack-out-of-range loop and assert the stuck signal fires within
  // two retries, matching the acceptance criterion.
  it('integration: scripted out-of-range attack loop surfaces stuck within 2 retries', () => {
    const d = createStuckDetector();
    const calls: ToolCallRecord[] = [
      // Turn 1: look, then try to attack a far-off goblin — fails.
      ok('look', {}),
      fail('act', { kind: 'attack', targetEntityId: 'goblin-7' }),
      // Turn 2: model doesn't learn, retries the same attack — stuck.
      fail('act', { kind: 'attack', targetEntityId: 'goblin-7' }),
    ];
    const signals = calls.map((c) => d.record(c));
    expect(signals[0]).toBeNull(); // ok call
    expect(signals[1]).toBeNull(); // first fail
    expect(signals[2]).not.toBeNull(); // second identical fail → stuck
    expect(signals[2]!.tool).toBe('act');
    expect(signals[2]!.consecutiveFailures).toBe(2);
  });

  it('integration: stuck does NOT surface silently — caller gets a non-null signal it can route to the user', () => {
    const d = createStuckDetector();
    const args = { kind: 'cast', spell: 'fireball', targetEntityId: 'orc-3' };
    d.record(fail('act', args));
    const signal = d.record(fail('act', args));
    // Loop's contract per the issue: on a non-null signal, surface to user.
    // We assert the signal carries enough to build a user message.
    expect(signal).toMatchObject({
      tool: 'act',
      argsHash: hashArgs(args),
      consecutiveFailures: 2,
    });
  });
});
