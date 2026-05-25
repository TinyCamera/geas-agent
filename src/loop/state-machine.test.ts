import { describe, it, expect } from 'vitest';
import {
  INITIAL_STATE,
  isTerminal,
  reduce,
  tryReduce,
  type LoopEvent,
  type LoopState,
} from './state-machine.js';

const ALL_STATES: readonly LoopState[] = [
  'idle',
  'awaiting-llm',
  'dispatching-tool',
  'awaiting-server',
  'narrating',
  'done',
  'error',
];

const ALL_EVENTS: readonly LoopEvent[] = [
  { kind: 'user-message' },
  { kind: 'llm-response', stop: 'tool_use' },
  { kind: 'llm-response', stop: 'end_turn' },
  { kind: 'llm-response', stop: 'max_tokens' },
  { kind: 'llm-response', stop: 'stop_sequence' },
  { kind: 'tool-result' },
  { kind: 'tool-error' },
  { kind: 'decision-needed-from-server' },
  { kind: 'decision-resolved' },
  { kind: 'narration-complete' },
  { kind: 'fatal-error' },
  { kind: 'user-disconnected' },
];

describe('loop state-machine', () => {
  it('initial state is idle', () => {
    expect(INITIAL_STATE).toBe('idle');
  });

  it('isTerminal flags only done + error', () => {
    expect(isTerminal('done')).toBe(true);
    expect(isTerminal('error')).toBe(true);
    for (const s of ALL_STATES) {
      if (s !== 'done' && s !== 'error') {
        expect(isTerminal(s)).toBe(false);
      }
    }
  });

  describe('happy-path turn: user-message → tool_use → result → end_turn → done', () => {
    it('walks the full sequence', () => {
      let s: LoopState = INITIAL_STATE;
      s = reduce(s, { kind: 'user-message' });
      expect(s).toBe('awaiting-llm');
      s = reduce(s, { kind: 'llm-response', stop: 'tool_use' });
      expect(s).toBe('dispatching-tool');
      // dispatching-tool collapses to awaiting-server via any non-result event;
      // simulate runner handing off by injecting a server push.
      s = reduce(s, { kind: 'decision-needed-from-server' });
      expect(s).toBe('awaiting-server');
      s = reduce(s, { kind: 'tool-result' });
      expect(s).toBe('awaiting-llm');
      s = reduce(s, { kind: 'llm-response', stop: 'end_turn' });
      expect(s).toBe('narrating');
      s = reduce(s, { kind: 'narration-complete' });
      expect(s).toBe('done');
      expect(isTerminal(s)).toBe(true);
    });
  });

  describe('tool-error from awaiting-server feeds back to LLM', () => {
    it('routes to awaiting-llm so the model can self-correct', () => {
      let s: LoopState = 'awaiting-server';
      s = reduce(s, { kind: 'tool-error' });
      expect(s).toBe('awaiting-llm');
    });
  });

  describe('universal terminals', () => {
    it('user-disconnected from any non-terminal state lands in error', () => {
      for (const s of ALL_STATES) {
        if (isTerminal(s)) continue;
        expect(reduce(s, { kind: 'user-disconnected' })).toBe('error');
      }
    });

    it('fatal-error from any non-terminal state lands in error', () => {
      for (const s of ALL_STATES) {
        if (isTerminal(s)) continue;
        expect(reduce(s, { kind: 'fatal-error' })).toBe('error');
      }
    });

    it('universal terminals are idempotent in terminal states', () => {
      expect(reduce('done', { kind: 'fatal-error' })).toBe('error');
      expect(reduce('error', { kind: 'user-disconnected' })).toBe('error');
    });
  });

  describe('exhaustive (state × event) table', () => {
    // Every pair either succeeds (yielding a known state) or fails with a
    // well-formed reason. No crashes, no `undefined` returns.
    it('every pair returns a well-formed Transition', () => {
      for (const s of ALL_STATES) {
        for (const e of ALL_EVENTS) {
          const t = tryReduce(s, e);
          if (t.ok) {
            expect(ALL_STATES).toContain(t.next);
          } else {
            expect(t.reason).toMatch(/illegal transition/);
          }
        }
      }
    });

    it('illegal transitions: idle accepts only user-message + universals', () => {
      for (const e of ALL_EVENTS) {
        const t = tryReduce('idle', e);
        if (
          e.kind === 'user-message' ||
          e.kind === 'user-disconnected' ||
          e.kind === 'fatal-error'
        ) {
          expect(t.ok).toBe(true);
        } else {
          expect(t.ok).toBe(false);
        }
      }
    });

    it('terminal states reject ordinary events', () => {
      for (const terminal of ['done', 'error'] as const) {
        for (const e of ALL_EVENTS) {
          const t = tryReduce(terminal, e);
          if (e.kind === 'user-disconnected' || e.kind === 'fatal-error') {
            expect(t.ok).toBe(true);
          } else {
            expect(t.ok).toBe(false);
          }
        }
      }
    });
  });

  describe('reduce() throws on illegal transitions', () => {
    it('throws with a descriptive message', () => {
      expect(() => reduce('idle', { kind: 'tool-result' })).toThrow(
        /illegal transition: idle \+ tool-result/,
      );
    });
  });

  describe('max_tokens stop is treated as a final turn', () => {
    // Rationale: at the state-machine layer we don't distinguish "model
    // ran out of room" from "model finished" — the runner inspects content
    // and decides whether to re-prompt. The state itself is the same.
    it('routes to narrating', () => {
      expect(
        reduce('awaiting-llm', { kind: 'llm-response', stop: 'max_tokens' }),
      ).toBe('narrating');
    });
  });

  describe('multi-tool turn: two tool_use cycles', () => {
    it('returns to awaiting-llm after each tool', () => {
      let s: LoopState = INITIAL_STATE;
      s = reduce(s, { kind: 'user-message' });
      // tool #1
      s = reduce(s, { kind: 'llm-response', stop: 'tool_use' });
      s = reduce(s, { kind: 'decision-needed-from-server' });
      s = reduce(s, { kind: 'tool-result' });
      expect(s).toBe('awaiting-llm');
      // tool #2
      s = reduce(s, { kind: 'llm-response', stop: 'tool_use' });
      s = reduce(s, { kind: 'decision-needed-from-server' });
      s = reduce(s, { kind: 'tool-result' });
      expect(s).toBe('awaiting-llm');
      // wrap up
      s = reduce(s, { kind: 'llm-response', stop: 'end_turn' });
      s = reduce(s, { kind: 'narration-complete' });
      expect(s).toBe('done');
    });
  });

  describe('server push during narration', () => {
    it('bounces to awaiting-server', () => {
      expect(
        reduce('narrating', { kind: 'decision-needed-from-server' }),
      ).toBe('awaiting-server');
    });
  });
});
