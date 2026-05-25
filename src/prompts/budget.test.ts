import { describe, it, expect } from 'vitest';
import {
  createRetryBudget,
  readRetryBudgetFromEnv,
  DEFAULT_RETRY_BUDGET,
  RETRY_BUDGET_ENV_VAR,
  type RetryFailureDetail,
} from './budget.js';

const detail = (overrides: Partial<RetryFailureDetail> = {}): RetryFailureDetail => ({
  tool: 'act',
  category: 'tool_error',
  reason: 'target out of range',
  ...overrides,
});

describe('readRetryBudgetFromEnv', () => {
  it('returns DEFAULT_RETRY_BUDGET when env var is unset', () => {
    expect(readRetryBudgetFromEnv({})).toBe(DEFAULT_RETRY_BUDGET);
  });

  it('returns DEFAULT_RETRY_BUDGET when env var is empty string', () => {
    expect(readRetryBudgetFromEnv({ [RETRY_BUDGET_ENV_VAR]: '' })).toBe(
      DEFAULT_RETRY_BUDGET,
    );
  });

  it('parses a positive integer from env', () => {
    expect(readRetryBudgetFromEnv({ [RETRY_BUDGET_ENV_VAR]: '7' })).toBe(7);
  });

  it('accepts zero as a valid override (disables retries)', () => {
    expect(readRetryBudgetFromEnv({ [RETRY_BUDGET_ENV_VAR]: '0' })).toBe(0);
  });

  it('falls back to default on non-numeric junk', () => {
    expect(readRetryBudgetFromEnv({ [RETRY_BUDGET_ENV_VAR]: 'three' })).toBe(
      DEFAULT_RETRY_BUDGET,
    );
  });

  it('falls back to default on negative values', () => {
    expect(readRetryBudgetFromEnv({ [RETRY_BUDGET_ENV_VAR]: '-1' })).toBe(
      DEFAULT_RETRY_BUDGET,
    );
  });

  it('falls back to default on non-integer values', () => {
    expect(readRetryBudgetFromEnv({ [RETRY_BUDGET_ENV_VAR]: '2.5' })).toBe(
      DEFAULT_RETRY_BUDGET,
    );
  });
});

describe('createRetryBudget', () => {
  it('defaults to DEFAULT_RETRY_BUDGET (3) when no override', () => {
    const b = createRetryBudget();
    expect(b.telemetry.budget).toBe(DEFAULT_RETRY_BUDGET);
    expect(DEFAULT_RETRY_BUDGET).toBe(3); // pin the documented default
  });

  it('accepts an explicit budget override', () => {
    const b = createRetryBudget({ budget: 5 });
    expect(b.telemetry.budget).toBe(5);
  });

  it('throws on a non-integer explicit override', () => {
    expect(() => createRetryBudget({ budget: 2.5 })).toThrow();
  });

  it('throws on a negative explicit override', () => {
    expect(() => createRetryBudget({ budget: -1 })).toThrow();
  });

  it('starts with retries=0 and not exhausted', () => {
    const b = createRetryBudget({ budget: 3 });
    expect(b.telemetry).toEqual({ budget: 3, retries: 0, exhausted: false });
  });

  it('increments retries on each non-exhausting recordRetry and returns null', () => {
    const b = createRetryBudget({ budget: 3 });
    expect(b.recordRetry(detail())).toBeNull();
    expect(b.telemetry.retries).toBe(1);
    expect(b.recordRetry(detail())).toBeNull();
    expect(b.telemetry.retries).toBe(2);
  });

  it('returns the exhausted event on the call that reaches budget', () => {
    const b = createRetryBudget({ budget: 3 });
    b.recordRetry(detail({ reason: 'first' }));
    b.recordRetry(detail({ reason: 'second' }));
    const evt = b.recordRetry(detail({ reason: 'third' }));
    expect(evt).not.toBeNull();
    expect(evt).toEqual({
      type: 'error',
      kind: 'retry_budget_exhausted',
      detail: { tool: 'act', category: 'tool_error', reason: 'third' },
      retries: 3,
      budget: 3,
    });
    expect(b.telemetry.exhausted).toBe(true);
  });

  it('budget=0 exhausts on the very first retry', () => {
    const b = createRetryBudget({ budget: 0 });
    const evt = b.recordRetry(detail());
    expect(evt).not.toBeNull();
    expect(evt!.kind).toBe('retry_budget_exhausted');
    expect(evt!.budget).toBe(0);
    expect(evt!.retries).toBe(0);
  });

  it('post-exhaustion recordRetry stays idempotent — returns event with latest detail, retries pinned at budget', () => {
    const b = createRetryBudget({ budget: 2 });
    b.recordRetry(detail({ reason: 'a' }));
    b.recordRetry(detail({ reason: 'b' })); // exhausts
    const evt = b.recordRetry(detail({ reason: 'c' }));
    expect(evt).not.toBeNull();
    expect(evt!.detail.reason).toBe('c');
    expect(evt!.retries).toBe(2);
    expect(b.telemetry.retries).toBe(2);
  });

  it('resets on onUserMessage()', () => {
    const b = createRetryBudget({ budget: 3 });
    b.recordRetry(detail());
    b.recordRetry(detail()); // exhausts at 2? no, budget=3
    expect(b.telemetry.retries).toBe(2);
    b.onUserMessage();
    expect(b.telemetry).toEqual({ budget: 3, retries: 0, exhausted: false });
    // Fresh turn: budget restored.
    expect(b.recordRetry(detail())).toBeNull();
  });

  it('resets on explicit reset()', () => {
    const b = createRetryBudget({ budget: 1 });
    b.recordRetry(detail()); // exhausts
    expect(b.telemetry.exhausted).toBe(true);
    b.reset();
    expect(b.telemetry.exhausted).toBe(false);
    expect(b.telemetry.retries).toBe(0);
  });

  it('env override is read when no explicit budget is passed', () => {
    const prev = process.env[RETRY_BUDGET_ENV_VAR];
    process.env[RETRY_BUDGET_ENV_VAR] = '7';
    try {
      const b = createRetryBudget();
      expect(b.telemetry.budget).toBe(7);
    } finally {
      if (prev === undefined) delete process.env[RETRY_BUDGET_ENV_VAR];
      else process.env[RETRY_BUDGET_ENV_VAR] = prev;
    }
  });

  // Spec-level "integration" test: scripted broken scenario, assert
  // loop-style consumer sees the exhausted event at budget=3 with the
  // last-failure detail attached. Mirrors the verification harness's
  // expectation.
  it('integration: scripted broken scenario exits cleanly at budget=3 with retry_budget_exhausted event', () => {
    const b = createRetryBudget({ budget: 3 });
    const failures: RetryFailureDetail[] = [
      { tool: 'act', category: 'validator', reason: "missing required arg 'targetEntityId'" },
      { tool: 'act', category: 'tool_error', reason: 'target out of range' },
      { tool: 'act', category: 'stuck', reason: 'same tool+args failing twice' },
    ];
    const events = failures.map((f) => b.recordRetry(f));
    expect(events[0]).toBeNull();
    expect(events[1]).toBeNull();
    expect(events[2]).not.toBeNull();
    expect(events[2]).toMatchObject({
      type: 'error',
      kind: 'retry_budget_exhausted',
      retries: 3,
      budget: 3,
      detail: { tool: 'act', category: 'stuck' },
    });
  });

  it('integration: fails loudly — exhaustion event is never silently null when over budget', () => {
    const b = createRetryBudget({ budget: 1 });
    const evt = b.recordRetry(detail({ reason: 'first and last' }));
    // The contract: when the budget is exhausted, the caller MUST receive
    // a non-null event so it can surface to the user. No silent no-op.
    expect(evt).not.toBeNull();
    expect(evt!.type).toBe('error');
    expect(evt!.detail.reason).toBe('first and last');
  });
});
