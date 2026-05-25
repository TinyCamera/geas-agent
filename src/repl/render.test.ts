/**
 * Renderer snapshot — ANSI off so the test reads as plain text. Drives a
 * scripted event sequence through `renderEvent` and walks the
 * `flushPieces`-shape of the CLI to confirm the rendered transcript.
 */

import { describe, expect, it } from 'vitest';
import { renderEvent, renderTelemetryLine, type RenderPiece } from './render.js';
import { PROTOCOL_VERSION, type ChannelAEvent } from '../server/wire.js';

function envelope(eventId: number): Pick<
  ChannelAEvent,
  'protocolVersion' | 'eventId' | 'ts' | 'uid' | 'characterId'
> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    eventId,
    ts: 0,
    uid: 'u',
    characterId: 'c',
  };
}

/** Mirror `flushPieces` from `cli.ts` so snapshots reflect terminal output. */
function transcript(events: readonly ChannelAEvent[]): string {
  let out = '';
  let midText = false;
  for (const ev of events) {
    const pieces: readonly RenderPiece[] = renderEvent(ev, { color: false });
    for (const p of pieces) {
      if (p.kind === 'inline') {
        out += p.text;
        midText = true;
      } else if (p.kind === 'line') {
        if (midText) {
          out += '\n';
          midText = false;
        }
        out += p.text + '\n';
      } else {
        if (midText) {
          out += '\n';
          midText = false;
        }
      }
    }
  }
  if (midText) out += '\n';
  return out;
}

describe('renderEvent', () => {
  it('text deltas stream inline, done flushes a newline', () => {
    const t = transcript([
      { ...envelope(1), type: 'text', text: 'You ' },
      { ...envelope(2), type: 'text', text: 'see a ' },
      { ...envelope(3), type: 'text', text: 'torchlit hall.' },
      { ...envelope(4), type: 'done', reason: 'end_turn' },
    ]);
    expect(t).toBe('You see a torchlit hall.\n');
  });

  it('tool_call + tool_result render dim with arrows', () => {
    const t = transcript([
      {
        ...envelope(1),
        type: 'tool_call',
        tool: 'look',
        args: {},
        intent: null,
      },
      {
        ...envelope(2),
        type: 'tool_result',
        tool: 'look',
        status: 'ok',
        attempts: 1,
      },
      { ...envelope(3), type: 'done', reason: 'end_turn' },
    ]);
    expect(t).toBe('  → look({})\n  ← look ok\n');
  });

  it('narration sits on its own line, distinct from chat text', () => {
    const t = transcript([
      { ...envelope(1), type: 'text', text: 'Hi.' },
      { ...envelope(2), type: 'narration', text: 'The crowd hushes.' },
      { ...envelope(3), type: 'done', reason: 'end_turn' },
    ]);
    expect(t).toBe('Hi.\nThe crowd hushes.\n');
  });

  it('decision with unknown shape renders generic prompt (no crash)', () => {
    const t = transcript([
      {
        ...envelope(1),
        type: 'decision',
        decisionId: 'd-7',
        payload: { picks: ['fire', 'ice'] },
      },
    ]);
    // Unknown kind, no options array — falls back to header + no-options hint.
    expect(t).toContain('Decision');
    expect(t).toContain('(no options');
  });

  it('decision level_up renders a numbered list', () => {
    const t = transcript([
      {
        ...envelope(1),
        type: 'decision',
        decisionId: 'd-9',
        payload: {
          kind: 'level_up',
          options: [
            { id: 'power-strike', label: 'Power Strike', description: 'STR +2' },
            { id: 'block', label: 'Block', description: '+10% dmg reduction' },
          ],
        },
      },
    ]);
    expect(t).toContain('Level up — pick one:');
    expect(t).toContain('[1] Power Strike — STR +2');
    expect(t).toContain('[2] Block — +10% dmg reduction');
    expect(t).toContain('Pick 1-2 (q to cancel):');
  });

  it('error event renders with an error: prefix', () => {
    const t = transcript([
      { ...envelope(1), type: 'error', message: 'transport down' },
    ]);
    expect(t).toBe('error: transport down\n');
  });

  it('hello + ping are silent', () => {
    const t = transcript([
      {
        ...envelope(1),
        type: 'hello',
        serverProtocolVersion: PROTOCOL_VERSION,
        resumeCursor: 0,
      },
      { ...envelope(2), type: 'ping' },
    ]);
    expect(t).toBe('');
  });

  it('telemetry renders as a dim cost line', () => {
    const line = renderTelemetryLine({
      ...envelope(1),
      type: 'telemetry',
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      costUsd: 0.0023,
      inputTokens: 172,
      outputTokens: 24,
      cacheReadInputTokens: 38,
      cacheCreationInputTokens: 0,
      latencyMs: 412,
    });
    expect(line).toBe('  $0.0023  (172 in / 38 cached / 24 out)');
  });

  it('color: true wraps lines in ANSI', () => {
    const pieces = renderEvent(
      {
        ...envelope(1),
        type: 'tool_call',
        tool: 'look',
        args: {},
        intent: null,
      },
      { color: true },
    );
    expect(pieces).toHaveLength(1);
    const piece = pieces[0];
    expect(piece.kind).toBe('line');
    if (piece.kind === 'line') {
      expect(piece.text).toContain('\x1b[2m');
      expect(piece.text).toContain('\x1b[0m');
    }
  });
});
