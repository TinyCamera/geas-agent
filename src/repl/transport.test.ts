/**
 * `parseEventFrame` table tests — the regression net for wire-format drift
 * between geas-agent and any Channel-A client (REPL #648, web #592).
 */

import { describe, expect, it } from 'vitest';
import { parseEventFrame } from './transport.js';
import { PROTOCOL_VERSION } from '../server/wire.js';

function frame(extra: Record<string, unknown>): string {
  return JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    eventId: 1,
    ts: 123,
    uid: 'u',
    characterId: 'c',
    ...extra,
  });
}

describe('parseEventFrame', () => {
  it('parses a text event', () => {
    const e = parseEventFrame(frame({ type: 'text', text: 'hi' }));
    expect(e.type).toBe('text');
    expect(e.eventId).toBe(1);
  });

  it('parses a tool_call event', () => {
    const e = parseEventFrame(
      frame({ type: 'tool_call', tool: 'look', args: {}, intent: 'recon' }),
    );
    expect(e.type).toBe('tool_call');
  });

  it('parses a tool_result event', () => {
    const e = parseEventFrame(
      frame({ type: 'tool_result', tool: 'look', status: 'ok', attempts: 1 }),
    );
    expect(e.type).toBe('tool_result');
  });

  it('parses a narration event', () => {
    const e = parseEventFrame(frame({ type: 'narration', text: 'A torchlit hall.' }));
    expect(e.type).toBe('narration');
  });

  it('parses a decision event', () => {
    const e = parseEventFrame(
      frame({ type: 'decision', decisionId: 'd1', payload: { picks: ['a', 'b'] } }),
    );
    expect(e.type).toBe('decision');
  });

  it('parses an error event', () => {
    const e = parseEventFrame(frame({ type: 'error', message: 'boom' }));
    expect(e.type).toBe('error');
  });

  it('parses a done event', () => {
    const e = parseEventFrame(frame({ type: 'done', reason: 'end_turn' }));
    expect(e.type).toBe('done');
  });

  it('parses a hello event', () => {
    const e = parseEventFrame(
      frame({
        type: 'hello',
        serverProtocolVersion: PROTOCOL_VERSION,
        resumeCursor: 0,
      }),
    );
    expect(e.type).toBe('hello');
  });

  it('parses a ping event', () => {
    const e = parseEventFrame(frame({ type: 'ping' }));
    expect(e.type).toBe('ping');
  });

  it('parses a telemetry event', () => {
    const e = parseEventFrame(
      frame({
        type: 'telemetry',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        costUsd: 0.0023,
        inputTokens: 172,
        outputTokens: 24,
        cacheReadInputTokens: 38,
        cacheCreationInputTokens: 0,
        latencyMs: 412,
      }),
    );
    expect(e.type).toBe('telemetry');
  });

  it('rejects non-JSON', () => {
    expect(() => parseEventFrame('not json')).toThrow(/not valid JSON/);
  });

  it('rejects wrong protocol version', () => {
    expect(() =>
      parseEventFrame(
        JSON.stringify({
          protocolVersion: 99,
          eventId: 1,
          ts: 1,
          uid: 'u',
          characterId: 'c',
          type: 'text',
          text: 'hi',
        }),
      ),
    ).toThrow(/protocolVersion/);
  });

  it('rejects missing envelope fields', () => {
    expect(() =>
      parseEventFrame(
        JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'text', text: 'hi' }),
      ),
    ).toThrow(/eventId/);
  });
});
