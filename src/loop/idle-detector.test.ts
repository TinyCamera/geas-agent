import { describe, expect, it } from 'vitest';
import { DEFAULT_IDLE_THRESHOLD_MS, isIdle, type IdleInputs } from './idle-detector.js';

const base: IdleInputs = {
  now: 1_000_000,
  lastUserMessageAt: null,
  inFlightToolCalls: 0,
  pendingDecision: false,
  idleThresholdMs: DEFAULT_IDLE_THRESHOLD_MS,
};

describe('isIdle', () => {
  it('returns idle when nothing has happened', () => {
    const v = isIdle(base);
    expect(v.isIdle).toBe(true);
    expect(v.activeReason).toBeNull();
  });

  it('returns active when an in-flight tool call exists', () => {
    const v = isIdle({ ...base, inFlightToolCalls: 1 });
    expect(v.isIdle).toBe(false);
    expect(v.activeReason).toBe('in-flight-tool-call');
  });

  it('returns active when a decision is pending', () => {
    const v = isIdle({ ...base, pendingDecision: true });
    expect(v.isIdle).toBe(false);
    expect(v.activeReason).toBe('pending-decision');
  });

  it('returns active inside the quiet window after a user message', () => {
    const v = isIdle({
      ...base,
      lastUserMessageAt: base.now - 5_000, // 5s ago, well under 30s
    });
    expect(v.isIdle).toBe(false);
    expect(v.activeReason).toBe('recent-user-message');
    expect(v.secondsSinceUserMessage).toBe(5);
  });

  it('returns idle exactly at the threshold boundary', () => {
    // Boundary: now - lastUserMessageAt === idleThresholdMs is idle
    // (`< threshold` is the active condition).
    const v = isIdle({
      ...base,
      lastUserMessageAt: base.now - DEFAULT_IDLE_THRESHOLD_MS,
    });
    expect(v.isIdle).toBe(true);
    expect(v.activeReason).toBeNull();
  });

  it('returns idle just past the threshold', () => {
    const v = isIdle({
      ...base,
      lastUserMessageAt: base.now - (DEFAULT_IDLE_THRESHOLD_MS + 1),
    });
    expect(v.isIdle).toBe(true);
  });

  it('prefers in-flight reason over pending decision when both are true', () => {
    const v = isIdle({
      ...base,
      inFlightToolCalls: 1,
      pendingDecision: true,
    });
    expect(v.activeReason).toBe('in-flight-tool-call');
  });

  it('prefers pending decision over recent-user-message when both are true', () => {
    const v = isIdle({
      ...base,
      pendingDecision: true,
      lastUserMessageAt: base.now - 1_000,
    });
    expect(v.activeReason).toBe('pending-decision');
  });

  it('reports secondsSinceUserMessage as Infinity when no user message yet', () => {
    const v = isIdle(base);
    expect(v.secondsSinceUserMessage).toBe(Number.POSITIVE_INFINITY);
  });

  it('respects a custom idleThresholdMs', () => {
    const tight = isIdle({
      ...base,
      lastUserMessageAt: base.now - 2_000,
      idleThresholdMs: 1_000,
    });
    expect(tight.isIdle).toBe(true);

    const loose = isIdle({
      ...base,
      lastUserMessageAt: base.now - 2_000,
      idleThresholdMs: 5_000,
    });
    expect(loose.isIdle).toBe(false);
    expect(loose.activeReason).toBe('recent-user-message');
  });
});
