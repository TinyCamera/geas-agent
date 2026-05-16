/**
 * Console + buffer logger implementations for scenarios.
 *
 * **Why a buffer logger lives in src/ instead of tests/.** The runner exposes a
 * `BufferLogger` so embedding callers (e.g. a future "run scenario as a test
 * step" harness) can capture output without monkey-patching console. It's a
 * trivial value type; putting it in tests/ would force a duplicate definition.
 */

import type { ScenarioLogger } from './types.js';

export function createConsoleLogger(prefix = '[scenario]'): ScenarioLogger {
  // We intentionally write to stdout/stderr via console — scenarios are short
  // operator-facing runs, structured logging is a deploy-time concern (deploy
  // epic #589 will swap this for a real sink). Keeping the surface tiny here
  // means the swap is a single-file change.
  return {
    info(message, detail) {
      if (detail === undefined) console.log(`${prefix} ${message}`);
      else console.log(`${prefix} ${message}`, detail);
    },
    warn(message, detail) {
      if (detail === undefined) console.warn(`${prefix} ${message}`);
      else console.warn(`${prefix} ${message}`, detail);
    },
    error(message, detail) {
      if (detail === undefined) console.error(`${prefix} ${message}`);
      else console.error(`${prefix} ${message}`, detail);
    },
  };
}

export interface BufferLoggerEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
  detail?: unknown;
}

export interface BufferLogger extends ScenarioLogger {
  entries: BufferLoggerEntry[];
}

export function createBufferLogger(): BufferLogger {
  const entries: BufferLoggerEntry[] = [];
  return {
    entries,
    info(message, detail) {
      entries.push({ level: 'info', message, detail });
    },
    warn(message, detail) {
      entries.push({ level: 'warn', message, detail });
    },
    error(message, detail) {
      entries.push({ level: 'error', message, detail });
    },
  };
}
