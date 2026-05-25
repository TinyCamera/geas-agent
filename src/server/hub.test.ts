import { describe, expect, it } from 'vitest';
import { EventHub, type Subscriber } from './hub.js';
import type { LoopEmitEvent } from '../loop/runner.js';
import type { ChannelAEvent } from './wire.js';

function makeSub(): Subscriber & { received: ChannelAEvent[] } {
  const received: ChannelAEvent[] = [];
  return {
    id: `sub-${Math.random()}`,
    received,
    send: (e) => {
      received.push(e);
    },
  };
}

describe('EventHub', () => {
  it('stamps eventId, uid, characterId, protocolVersion on every event', () => {
    const hub = new EventHub({ now: () => 4242 });
    const sub = makeSub();
    hub.subscribe('u1', 'c1', sub, 0);
    const emit = hub.emitterFor('u1', 'c1');
    emit({ type: 'text-delta', text: 'hello' });
    expect(sub.received).toHaveLength(1);
    const e = sub.received[0];
    expect(e.protocolVersion).toBe(1);
    expect(e.eventId).toBe(1);
    expect(e.ts).toBe(4242);
    expect(e.uid).toBe('u1');
    expect(e.characterId).toBe('c1');
    expect(e.type).toBe('text');
  });

  it('fans out to multiple subscribers on the same stream', () => {
    const hub = new EventHub();
    const a = makeSub();
    const b = makeSub();
    hub.subscribe('u', 'c', a, 0);
    hub.subscribe('u', 'c', b, 0);
    hub.emitterFor('u', 'c')({ type: 'narration', text: 'whoa' });
    expect(a.received).toHaveLength(1);
    expect(b.received).toHaveLength(1);
  });

  it('does not leak events across (uid, characterId) keys', () => {
    const hub = new EventHub();
    const a = makeSub();
    const b = makeSub();
    hub.subscribe('u1', 'c1', a, 0);
    hub.subscribe('u2', 'c1', b, 0);
    hub.emitterFor('u1', 'c1')({ type: 'text-delta', text: 'x' });
    expect(a.received).toHaveLength(1);
    expect(b.received).toHaveLength(0);
  });

  it('replays buffered events on subscribe with `since`', () => {
    const hub = new EventHub();
    const emit = hub.emitterFor('u', 'c');
    emit({ type: 'text-delta', text: '1' });
    emit({ type: 'text-delta', text: '2' });
    emit({ type: 'text-delta', text: '3' });
    const sub = makeSub();
    const { resumeCursor, replayed } = hub.subscribe('u', 'c', sub, 1);
    expect(resumeCursor).toBe(3);
    expect(replayed).toBe(2);
    expect(sub.received.map((e) => (e as { text: string }).text)).toEqual([
      '2',
      '3',
    ]);
  });

  it('lifts each LoopEmitEvent variant to the right wire shape', () => {
    const hub = new EventHub({ now: () => 1 });
    const sub = makeSub();
    hub.subscribe('u', 'c', sub, 0);
    const emit = hub.emitterFor('u', 'c');

    const events: LoopEmitEvent[] = [
      { type: 'text-delta', text: 't' },
      {
        type: 'tool-call',
        plan: { tool: 'move', args: { dx: 1 }, intent: 'go east' },
      },
      {
        type: 'tool-result',
        tool: 'move',
        outcome: {
          status: 'ok',
          value: { content: [{ type: 'text', text: 'ok' }] },
          attempts: 1,
          recovered: false,
        },
      },
      {
        type: 'tool-result',
        tool: 'move',
        outcome: {
          status: 'exhausted',
          attempts: 3,
          event: {
            kind: 'transport',
            attempts: 3,
            elapsedMs: 100,
          } as unknown as import('../prompts/budget.js').RetryBudgetExhaustedEvent,
          lastFailure: {
            toolName: 'move',
            args: {},
            reason: 'tool_error: nope',
          },
        },
      },
      { type: 'narration', text: 'narration' },
      { type: 'decision', decisionId: 'd1', payload: { foo: 1 } },
      { type: 'error', message: 'boom' },
      { type: 'done', reason: 'end_turn' },
    ];
    for (const e of events) emit(e);

    const types = sub.received.map((e) => e.type);
    expect(types).toEqual([
      'text',
      'tool_call',
      'tool_result',
      'tool_result',
      'narration',
      'decision',
      'error',
      'done',
    ]);
    // Spot-check the tool_call shape.
    const toolCall = sub.received[1] as {
      tool: string;
      args: unknown;
      intent: string | null;
    };
    expect(toolCall.tool).toBe('move');
    expect(toolCall.args).toEqual({ dx: 1 });
    expect(toolCall.intent).toBe('go east');
  });

  it('unsubscribe stops further events for that subscriber', () => {
    const hub = new EventHub();
    const sub = makeSub();
    hub.subscribe('u', 'c', sub, 0);
    hub.emitterFor('u', 'c')({ type: 'text-delta', text: '1' });
    hub.unsubscribe('u', 'c', sub.id);
    hub.emitterFor('u', 'c')({ type: 'text-delta', text: '2' });
    expect(sub.received).toHaveLength(1);
  });
});
