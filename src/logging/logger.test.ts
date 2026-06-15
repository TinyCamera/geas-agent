/**
 * Unit tests for the structured logger (#680).
 *
 * The privacy guarantees are the load-bearing ones — a leaked refresh token or
 * a full user-message body in Cloud Logging is a real incident — so the bulk
 * of this file asserts redaction + truncation against captured output, exactly
 * the test the ticket's Tests section calls for ("feed a log entry with a
 * refresh token, assert it doesn't appear in output").
 */

import { describe, it, expect } from 'vitest';
import type { DestinationStream } from 'pino';

import {
  createLogger,
  sanitize,
  MAX_BODY_CHARS,
} from './logger.js';

/** A pino destination that buffers every emitted line as a parsed object. */
function capture(): {
  stream: DestinationStream;
  lines: () => Array<Record<string, unknown>>;
  raw: () => string;
} {
  let buf = '';
  return {
    stream: { write: (s: string) => void (buf += s) },
    lines: () =>
      buf
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    raw: () => buf,
  };
}

describe('logger — redaction', () => {
  it('redacts a refresh token and never emits the plaintext', () => {
    const sink = capture();
    const log = createLogger({ destination: sink.stream });

    log.info('token-refreshed', {
      uid: 'u1',
      refreshToken: 'super-secret-refresh-abc123',
    });

    log.raw.flush?.();
    const raw = sink.raw();
    expect(raw).not.toContain('super-secret-refresh-abc123');
    const [line] = sink.lines();
    expect(line.refreshToken).toBe('[REDACTED]');
    expect(line.uid).toBe('u1');
  });

  it('redacts id tokens, access tokens, bearer tokens, and secrets', () => {
    const sink = capture();
    const log = createLogger({ destination: sink.stream });

    log.info('auth-checked', {
      idToken: 'id-tok-xyz',
      accessToken: 'acc-tok-xyz',
      bearerToken: 'bearer-xyz',
      authorization: 'Bearer leak-me',
      password: 'hunter2',
      apiKey: 'sk-leak',
      nested: { clientSecret: 'shh' },
    });

    log.raw.flush?.();
    const raw = sink.raw();
    for (const leak of [
      'id-tok-xyz',
      'acc-tok-xyz',
      'bearer-xyz',
      'leak-me',
      'hunter2',
      'sk-leak',
      'shh',
    ]) {
      expect(raw).not.toContain(leak);
    }
    const [line] = sink.lines();
    expect(line.idToken).toBe('[REDACTED]');
    expect(line.accessToken).toBe('[REDACTED]');
    expect(line.bearerToken).toBe('[REDACTED]');
    expect(line.authorization).toBe('[REDACTED]');
    expect((line.nested as Record<string, unknown>).clientSecret).toBe(
      '[REDACTED]',
    );
  });

  it('does NOT redact token-count fields (usage counters, not credentials)', () => {
    const sink = capture();
    const log = createLogger({ destination: sink.stream });

    log.info('turn-complete', { totalTokens: 1234, tokens: 56, tokenCount: 7 });

    log.raw.flush?.();
    const [line] = sink.lines();
    expect(line.totalTokens).toBe(1234);
    expect(line.tokens).toBe(56);
    expect(line.tokenCount).toBe(7);
  });
});

describe('logger — truncation', () => {
  it('truncates message bodies beyond 200 chars', () => {
    const sink = capture();
    const log = createLogger({ destination: sink.stream });
    const longBody = 'x'.repeat(500);

    log.info('chat-received', { message: longBody });

    log.raw.flush?.();
    const raw = sink.raw();
    expect(raw).not.toContain('x'.repeat(500));
    const [line] = sink.lines();
    const msg = line.message as string;
    expect(msg.startsWith('x'.repeat(MAX_BODY_CHARS))).toBe(true);
    expect(msg).toContain('[+300 chars]');
  });

  it('leaves short bodies untouched', () => {
    const sink = capture();
    const log = createLogger({ destination: sink.stream });
    log.info('chat-received', { body: 'short and sweet' });
    log.raw.flush?.();
    expect(sink.lines()[0].body).toBe('short and sweet');
  });
});

describe('logger — contract fields', () => {
  it('emits severity (not numeric level) and the event verb', () => {
    const sink = capture();
    const log = createLogger({ destination: sink.stream });

    log.error('tool-call-failed', { tool: 'attack' });

    log.raw.flush?.();
    const [line] = sink.lines();
    expect(line.severity).toBe('ERROR');
    expect(line.level).toBeUndefined();
    expect(line.event).toBe('tool-call-failed');
    expect(line.tool).toBe('attack');
  });

  it('binds correlation context via child()', () => {
    const sink = capture();
    const log = createLogger({ destination: sink.stream }).child({
      uid: 'u9',
      characterId: 'c9',
      sessionId: 's9',
      traceId: 't9',
    });

    log.info('session-started');

    log.raw.flush?.();
    const [line] = sink.lines();
    expect(line.uid).toBe('u9');
    expect(line.characterId).toBe('c9');
    expect(line.sessionId).toBe('s9');
    expect(line.traceId).toBe('t9');
    expect(line.event).toBe('session-started');
  });

  it('a stray event key in fields cannot shadow the verb', () => {
    const sink = capture();
    const log = createLogger({ destination: sink.stream });
    log.info('real-event', { event: 'spoofed' });
    log.raw.flush?.();
    expect(sink.lines()[0].event).toBe('real-event');
  });

  it('maps debug/warn levels to DEBUG/WARN severities', () => {
    const sink = capture();
    // level defaults to 'debug' outside production, so debug lines emit.
    const log = createLogger({ destination: sink.stream });
    log.debug('a');
    log.warn('b');
    log.raw.flush?.();
    const lines = sink.lines();
    expect(lines.find((l) => l.event === 'a')?.severity).toBe('DEBUG');
    expect(lines.find((l) => l.event === 'b')?.severity).toBe('WARN');
  });
});

describe('sanitize — directly', () => {
  it('cuts circular references', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const out = sanitize(a) as Record<string, unknown>;
    expect(out.name).toBe('a');
    expect(out.self).toBe('[Circular]');
  });

  it('normalizes Error objects to a safe shape', () => {
    const err = new Error('boom '.repeat(100));
    const out = sanitize({ err }) as Record<string, Record<string, unknown>>;
    expect(out.err.name).toBe('Error');
    expect((out.err.message as string).length).toBeLessThanOrEqual(
      MAX_BODY_CHARS + 32,
    );
    expect(typeof out.err.stack).toBe('string');
  });

  it('redacts secrets nested in arrays', () => {
    const out = sanitize({
      creds: [{ refreshToken: 'leak' }],
    }) as Record<string, Array<Record<string, unknown>>>;
    expect(out.creds[0].refreshToken).toBe('[REDACTED]');
  });
});
