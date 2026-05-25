/**
 * REPL renderer (issue #648).
 *
 * Pure functions that turn one wire event into one or more terminal
 * strings (already-ANSI). Kept separate from the `Transport` and CLI loop
 * so unit tests can snapshot the output deterministically by feeding the
 * function a scripted event sequence.
 *
 * **ANSI policy.** Colour is opt-in via the `color` flag on the renderer.
 * Default ON for an interactive TTY; tests use `color: false` so the
 * snapshot stays readable. We never inject ANSI into the *content* — only
 * around it — so an `--ansi-strip` postprocess yields the same output.
 *
 * **Text deltas don't get newlines.** Chat responses stream char-by-char
 * (well, token-by-token); each delta is written inline with no trailing
 * newline. The CLI flushes a final newline once `done` lands.
 */

import type { ChannelAEvent, TelemetryEvent } from '../server/wire.js';

export interface RenderOptions {
  readonly color: boolean;
}

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

function wrap(opts: RenderOptions, code: string, s: string): string {
  return opts.color ? `${code}${s}${ANSI.reset}` : s;
}

/**
 * Convert one event into the rendered output. Returns a `pieces` array
 * (each is a discrete chunk to write to stdout) so callers can decide on
 * line ergonomics (e.g. group text deltas without forcing newlines).
 *
 * Each piece is one of:
 *   `{ kind: 'inline', text }` — write as-is, no trailing newline.
 *   `{ kind: 'line', text }`   — write text + `\n`.
 *   `{ kind: 'turn-end' }`     — flush a final newline if mid-text.
 */
export type RenderPiece =
  | { readonly kind: 'inline'; readonly text: string }
  | { readonly kind: 'line'; readonly text: string }
  | { readonly kind: 'turn-end' };

export function renderEvent(
  event: ChannelAEvent,
  opts: RenderOptions = { color: true },
): readonly RenderPiece[] {
  switch (event.type) {
    case 'text':
      return [{ kind: 'inline', text: event.text }];
    case 'tool_call': {
      const args =
        event.args === undefined || event.args === null
          ? ''
          : JSON.stringify(event.args);
      const line = `  → ${event.tool}(${args})`;
      return [{ kind: 'line', text: wrap(opts, ANSI.dim, line) }];
    }
    case 'tool_result': {
      const line = `  ← ${event.tool} ${event.status}`;
      return [{ kind: 'line', text: wrap(opts, ANSI.dim, line) }];
    }
    case 'narration': {
      // Distinct block — italic + leading newline so it stands off the chat text.
      return [
        { kind: 'turn-end' },
        { kind: 'line', text: wrap(opts, ANSI.italic, event.text) },
      ];
    }
    case 'decision': {
      // #649 replaces this with an interactive prompt. For now, verbatim JSON.
      return [
        { kind: 'turn-end' },
        {
          kind: 'line',
          text: wrap(
            opts,
            ANSI.yellow,
            `[decision ${event.decisionId}] ${JSON.stringify(event.payload)}`,
          ),
        },
      ];
    }
    case 'error':
      return [
        { kind: 'turn-end' },
        { kind: 'line', text: wrap(opts, ANSI.red, `error: ${event.message}`) },
      ];
    case 'telemetry':
      return [{ kind: 'line', text: wrap(opts, ANSI.dim, renderTelemetryLine(event)) }];
    case 'done':
      return [{ kind: 'turn-end' }];
    // Hello + ping are transport-level — REPL doesn't surface them.
    case 'hello':
    case 'ping':
      return [];
  }
}

/** The "$0.0023  (172 in / 38 cached / 24 out)" line. Exported for tests. */
export function renderTelemetryLine(ev: TelemetryEvent): string {
  const dollars = ev.costUsd < 0.01
    ? `$${ev.costUsd.toFixed(4)}`
    : `$${ev.costUsd.toFixed(2)}`;
  const inTok = ev.inputTokens;
  const cacheTok = ev.cacheReadInputTokens;
  const outTok = ev.outputTokens;
  return `  ${dollars}  (${inTok} in / ${cacheTok} cached / ${outTok} out)`;
}
