/**
 * Unit tests for `assembleTurn`. Pure function — drive event sequences
 * synthetically and assert the assembled `TurnResult`.
 */

import { describe, expect, it } from 'vitest';
import { assembleTurn } from './assemble-turn.js';
import { PROTOCOL_VERSION, type ChannelAEvent } from './wire.js';

let nextId = 1;
function ev(partial: Record<string, unknown>): ChannelAEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    eventId: nextId++,
    ts: 1_700_000_000_000,
    uid: 'u1',
    characterId: 'c1',
    ...partial,
  } as unknown as ChannelAEvent;
}

describe('assembleTurn', () => {
  it('end_turn happy path: text + tool_call + tool_result + narration + done', () => {
    nextId = 1;
    const events: ChannelAEvent[] = [
      ev({ type: 'text', text: 'You see ' }),
      ev({ type: 'tool_call', tool: 'look', args: {}, intent: 'survey' }),
      ev({
        type: 'tool_result',
        tool: 'look',
        status: 'ok',
        attempts: 1,
        value: { room: 'hall' },
      }),
      ev({ type: 'narration', text: 'A torchlit hall.' }),
      ev({ type: 'text', text: 'a torchlit hall.' }),
      ev({ type: 'done', reason: 'end_turn' }),
    ];
    const t = assembleTurn('look', events);
    expect(t.userMessage).toBe('look');
    expect(t.assistantText).toBe('You see a torchlit hall.');
    expect(t.toolCalls).toEqual([
      { id: 'tc-1', name: 'look', args: {}, intent: 'survey' },
    ]);
    expect(t.toolResults).toEqual([
      { tool: 'look', status: 'ok', attempts: 1, value: { room: 'hall' } },
    ]);
    expect(t.narration).toEqual(['A torchlit hall.']);
    expect(t.decisions).toEqual([]);
    expect(t.telemetry).toBeNull();
    expect(t.stopReason).toBe('end_turn');
    expect(t.errorMessage).toBeUndefined();
  });

  it('aborted: done.reason=aborted is reflected', () => {
    nextId = 1;
    const events: ChannelAEvent[] = [
      ev({ type: 'text', text: 'half-' }),
      ev({ type: 'done', reason: 'aborted' }),
    ];
    const t = assembleTurn('go', events);
    expect(t.stopReason).toBe('aborted');
    expect(t.assistantText).toBe('half-');
  });

  it('error: error frame without done → stopReason=error + errorMessage', () => {
    nextId = 1;
    const events: ChannelAEvent[] = [
      ev({ type: 'error', message: 'provider exploded' }),
    ];
    const t = assembleTurn('hi', events);
    expect(t.stopReason).toBe('error');
    expect(t.errorMessage).toBe('provider exploded');
  });

  it('error + done: done wins but errorMessage still captured', () => {
    nextId = 1;
    const events: ChannelAEvent[] = [
      ev({ type: 'error', message: 'tool wobble' }),
      ev({ type: 'done', reason: 'end_turn' }),
    ];
    const t = assembleTurn('hi', events);
    expect(t.stopReason).toBe('end_turn');
    expect(t.errorMessage).toBe('tool wobble');
  });

  it('timeout: opts.timedOut + no done → stopReason=timeout', () => {
    nextId = 1;
    const events: ChannelAEvent[] = [
      ev({ type: 'tool_call', tool: 'look', args: {}, intent: null }),
    ];
    const t = assembleTurn('look', events, { timedOut: true });
    expect(t.stopReason).toBe('timeout');
    expect(t.toolCalls).toHaveLength(1);
  });

  it('timeout overridden by error frame', () => {
    nextId = 1;
    const events: ChannelAEvent[] = [
      ev({ type: 'error', message: 'kaboom' }),
    ];
    const t = assembleTurn('hi', events, { timedOut: true });
    expect(t.stopReason).toBe('error');
  });

  it('filters hello and ping frames', () => {
    nextId = 1;
    const events: ChannelAEvent[] = [
      ev({ type: 'hello', serverProtocolVersion: PROTOCOL_VERSION, resumeCursor: 0 }),
      ev({ type: 'ping' }),
      ev({ type: 'text', text: 'hi' }),
      ev({ type: 'ping' }),
      ev({ type: 'done', reason: 'end_turn' }),
    ];
    const t = assembleTurn('hi', events);
    expect(t.assistantText).toBe('hi');
    expect(t.stopReason).toBe('end_turn');
  });

  it('concatenates multiple text deltas in order', () => {
    nextId = 1;
    const events: ChannelAEvent[] = [
      ev({ type: 'text', text: 'a' }),
      ev({ type: 'text', text: 'b' }),
      ev({ type: 'text', text: 'c' }),
      ev({ type: 'done', reason: 'end_turn' }),
    ];
    const t = assembleTurn('', events);
    expect(t.assistantText).toBe('abc');
  });

  it('keeps only the last telemetry frame', () => {
    nextId = 1;
    const events: ChannelAEvent[] = [
      ev({
        type: 'telemetry',
        provider: 'p',
        model: 'm',
        costUsd: 0.01,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        latencyMs: 100,
      }),
      ev({
        type: 'telemetry',
        provider: 'p',
        model: 'm',
        costUsd: 0.03,
        inputTokens: 200,
        outputTokens: 80,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        latencyMs: 250,
      }),
      ev({ type: 'done', reason: 'end_turn' }),
    ];
    const t = assembleTurn('', events);
    expect(t.telemetry?.costUsd).toBe(0.03);
    expect(t.telemetry?.outputTokens).toBe(80);
  });

  it('multiple tool calls get unique synthesised ids', () => {
    nextId = 1;
    const events: ChannelAEvent[] = [
      ev({ type: 'tool_call', tool: 'look', args: {}, intent: null }),
      ev({ type: 'tool_call', tool: 'move', args: { dx: 1 }, intent: 'go' }),
      ev({ type: 'done', reason: 'end_turn' }),
    ];
    const t = assembleTurn('', events);
    expect(t.toolCalls.map((c) => c.id)).toEqual(['tc-1', 'tc-2']);
    expect(t.toolCalls[1]).toEqual({
      id: 'tc-2',
      name: 'move',
      args: { dx: 1 },
      intent: 'go',
    });
  });

  it('only first done is treated as terminal', () => {
    nextId = 1;
    const events: ChannelAEvent[] = [
      ev({ type: 'done', reason: 'end_turn' }),
      ev({ type: 'done', reason: 'aborted' }),
    ];
    const t = assembleTurn('', events);
    expect(t.stopReason).toBe('end_turn');
  });

  it('decision events are captured in order', () => {
    nextId = 1;
    const events: ChannelAEvent[] = [
      ev({
        type: 'decision',
        decisionId: 'd1',
        payload: { question: 'fight or flee?' },
      }),
      ev({ type: 'done', reason: 'end_turn' }),
    ];
    const t = assembleTurn('', events);
    expect(t.decisions).toEqual([
      { decisionId: 'd1', payload: { question: 'fight or flee?' } },
    ]);
  });

  it('tolerates a sequence with no events at all', () => {
    const t = assembleTurn('hi', []);
    expect(t.assistantText).toBe('');
    expect(t.toolCalls).toEqual([]);
    expect(t.stopReason).toBe('end_turn'); // no error, no timeout
  });

  it('preserves lastFailure on non-ok tool_result', () => {
    nextId = 1;
    const events: ChannelAEvent[] = [
      ev({
        type: 'tool_result',
        tool: 'attack',
        status: 'exhausted',
        attempts: 3,
        lastFailure: { reason: 'no target' },
      }),
      ev({ type: 'done', reason: 'end_turn' }),
    ];
    const t = assembleTurn('attack', events);
    expect(t.toolResults).toEqual([
      {
        tool: 'attack',
        status: 'exhausted',
        attempts: 3,
        lastFailure: { reason: 'no target' },
      },
    ]);
  });
});
