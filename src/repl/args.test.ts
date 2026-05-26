import { describe, it, expect } from 'vitest';
import { parseArgs } from './args.js';

describe('parseArgs', () => {
  it('defaults to mode=new with no args', () => {
    expect(parseArgs([])).toEqual({ mode: 'new' });
  });

  it('--new is explicit but equivalent to no flag', () => {
    expect(parseArgs(['--new'])).toEqual({ mode: 'new' });
  });

  it('--list maps to mode=list', () => {
    expect(parseArgs(['--list'])).toEqual({ mode: 'list' });
  });

  it('--session <id> maps to mode=resume', () => {
    expect(parseArgs(['--session', 'sess-abc'])).toEqual({
      mode: 'resume',
      sessionId: 'sess-abc',
    });
  });

  it('--session without an id is an error', () => {
    const got = parseArgs(['--session']);
    expect(got.mode).toBe('error');
  });

  it('--session followed by a flag is an error', () => {
    const got = parseArgs(['--session', '--list']);
    expect(got.mode).toBe('error');
  });

  it('--list + --session is mutually-exclusive', () => {
    const got = parseArgs(['--list', '--session', 'x']);
    expect(got.mode).toBe('error');
    expect(got.mode === 'error' && got.message).toMatch(/mutually exclusive/i);
  });

  it('--list + --new is mutually-exclusive', () => {
    expect(parseArgs(['--list', '--new']).mode).toBe('error');
  });

  it('--session + --new is mutually-exclusive', () => {
    expect(parseArgs(['--session', 'x', '--new']).mode).toBe('error');
  });

  it('-h returns help mode', () => {
    expect(parseArgs(['-h'])).toEqual({ mode: 'help' });
    expect(parseArgs(['--help'])).toEqual({ mode: 'help' });
  });

  it('unknown flags are an error', () => {
    expect(parseArgs(['--nope']).mode).toBe('error');
  });

  it('--new-character with no name maps to mode=new-character (no name)', () => {
    expect(parseArgs(['--new-character'])).toEqual({ mode: 'new-character' });
  });

  it('--new-character with a name attaches it', () => {
    expect(parseArgs(['--new-character', 'Alice'])).toEqual({
      mode: 'new-character',
      name: 'Alice',
    });
  });

  it('--new-character followed by a flag treats the flag as a separate arg', () => {
    // Bare `--new-character --list` is mutually-exclusive, not a name=`--list`.
    const got = parseArgs(['--new-character', '--list']);
    expect(got.mode).toBe('error');
    expect(got.mode === 'error' && got.message).toMatch(/mutually exclusive/i);
  });

  it('--new-character + --new is mutually-exclusive', () => {
    expect(parseArgs(['--new-character', '--new']).mode).toBe('error');
  });

  it('--new-character + --session is mutually-exclusive', () => {
    expect(parseArgs(['--new-character', '--session', 'x']).mode).toBe('error');
  });
});
