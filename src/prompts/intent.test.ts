import { describe, it, expect } from 'vitest';
import type { ContentBlock } from '../llm/provider.js';
import { parseTurnIntents, intentForToolUse } from './intent.js';

function text(s: string): ContentBlock {
  return { type: 'text', text: s };
}
function toolUse(
  id: string,
  name: string,
  input: Record<string, unknown> = {},
): ContentBlock {
  return { type: 'tool_use', id, name, input };
}

describe('parseTurnIntents', () => {
  it('pairs a leading Intent: line with the following tool_use', () => {
    const out = parseTurnIntents([
      text('Intent: scout north for goblins'),
      toolUse('tu_1', 'act', { kind: 'move' }),
    ]);
    expect(out.tools).toEqual([
      {
        toolUseId: 'tu_1',
        toolName: 'act',
        intent: 'scout north for goblins',
        missing: false,
      },
    ]);
    expect(out.anyMissing).toBe(false);
  });

  it('extracts the Intent: line even when preceded by narrative text', () => {
    // Models sometimes emit a sentence of preamble before the intent line.
    const out = parseTurnIntents([
      text(
        "Looking at the map, I should head north.\nIntent: scout north for goblins",
      ),
      toolUse('tu_1', 'act'),
    ]);
    expect(out.tools[0]?.intent).toBe('scout north for goblins');
    expect(out.tools[0]?.missing).toBe(false);
  });

  it('treats Intent: none as explicit absence (intent=null, missing=false)', () => {
    const out = parseTurnIntents([
      text('Intent: none'),
      toolUse('tu_1', 'look'),
    ]);
    expect(out.tools[0]?.intent).toBeNull();
    expect(out.tools[0]?.missing).toBe(false);
    expect(out.anyMissing).toBe(false);
  });

  it('also accepts "Intent: NONE" (case-insensitive payload)', () => {
    const out = parseTurnIntents([
      text('Intent: NONE'),
      toolUse('tu_1', 'look'),
    ]);
    expect(out.tools[0]?.intent).toBeNull();
    expect(out.tools[0]?.missing).toBe(false);
  });

  it('flags a tool_use with no preceding Intent: line as missing', () => {
    const out = parseTurnIntents([
      text("I'll just take a look around."),
      toolUse('tu_1', 'look'),
    ]);
    expect(out.tools[0]?.intent).toBeNull();
    expect(out.tools[0]?.missing).toBe(true);
    expect(out.anyMissing).toBe(true);
  });

  it('treats malformed Intent: (empty payload) as missing', () => {
    const out = parseTurnIntents([
      text('Intent:'),
      toolUse('tu_1', 'look'),
    ]);
    expect(out.tools[0]?.intent).toBeNull();
    expect(out.tools[0]?.missing).toBe(true);
  });

  it('does not false-positive on the word "intent" mid-paragraph', () => {
    // "My intent is X" must not match — only a line starting with `Intent:`.
    const out = parseTurnIntents([
      text('My intent is to scout north.'),
      toolUse('tu_1', 'look'),
    ]);
    expect(out.tools[0]?.missing).toBe(true);
  });

  it('does not match lowercase "intent:" at line start', () => {
    const out = parseTurnIntents([
      text('intent: scout north'),
      toolUse('tu_1', 'look'),
    ]);
    expect(out.tools[0]?.missing).toBe(true);
  });

  it('pairs separate intents with separate tool_use blocks in one turn', () => {
    const out = parseTurnIntents([
      text('Intent: scout north for goblins'),
      toolUse('tu_1', 'act'),
      text('Intent: drain look events'),
      toolUse('tu_2', 'look'),
    ]);
    expect(out.tools.map((t) => t.intent)).toEqual([
      'scout north for goblins',
      'drain look events',
    ]);
    expect(out.anyMissing).toBe(false);
  });

  it('clears the pending intent after consuming it (subsequent tool_use is missing)', () => {
    const out = parseTurnIntents([
      text('Intent: scout north for goblins'),
      toolUse('tu_1', 'act'),
      toolUse('tu_2', 'look'), // no fresh intent → missing
    ]);
    expect(out.tools[0]?.intent).toBe('scout north for goblins');
    expect(out.tools[0]?.missing).toBe(false);
    expect(out.tools[1]?.intent).toBeNull();
    expect(out.tools[1]?.missing).toBe(true);
    expect(out.anyMissing).toBe(true);
  });

  it('returns empty tools list when the turn has no tool_use blocks', () => {
    const out = parseTurnIntents([text('Intent: scout north'), text('Just thinking.')]);
    expect(out.tools).toEqual([]);
    expect(out.anyMissing).toBe(false);
  });

  it('trims surrounding whitespace from the captured intent', () => {
    const out = parseTurnIntents([
      text('Intent:    scout north for goblins   '),
      toolUse('tu_1', 'act'),
    ]);
    expect(out.tools[0]?.intent).toBe('scout north for goblins');
  });
});

describe('intentForToolUse', () => {
  const parsed = parseTurnIntents([
    text('Intent: scout north'),
    toolUse('tu_1', 'act'),
    toolUse('tu_2', 'look'),
  ]);

  it('returns the intent string when present', () => {
    expect(intentForToolUse(parsed, 'tu_1')).toBe('scout north');
  });

  it('returns null for a tool_use that had no intent', () => {
    expect(intentForToolUse(parsed, 'tu_2')).toBeNull();
  });

  it('returns null for an unknown tool_use id', () => {
    expect(intentForToolUse(parsed, 'tu_does_not_exist')).toBeNull();
  });
});
