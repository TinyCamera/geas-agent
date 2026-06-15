/**
 * Structured JSON logging for geas-agent (#680, parent epic #590).
 *
 * **Why.** geas-agent is a long-running, multi-tenant process: one box hosts
 * many characters across many users. When something goes wrong in production
 * we filter Cloud Logging, not scroll a terminal — so every log line is a
 * JSON object with a stable `severity` + `event` shape. Queries like
 * `severity=ERROR AND event=tool-call-failed` have to return clean results.
 *
 * **Contract** (the fields every log line carries where applicable):
 *   - `severity`  — DEBUG | INFO | WARN | ERROR (Cloud Logging severity names).
 *   - `event`     — kebab-case verb, the first arg to every log method.
 *   - `uid`, `characterId`, `sessionId`, `traceId` — request correlation,
 *     bound once per request via {@link AppLogger.child} so call sites don't
 *     repeat them.
 *
 * **Privacy.** {@link sanitize} runs over every field object before it reaches
 * pino: it redacts anything token-shaped (refresh tokens, ID tokens, access
 * tokens, bearer tokens, generic secrets) and truncates message-body-ish
 * fields to {@link MAX_BODY_CHARS}. We never want a refresh token or a full
 * user message body in Cloud Logging.
 *
 * **Output.** JSON to stdout always, except in local dev where `pino-pretty`
 * (a devDependency) renders it human-readably. Production installs
 * (`--omit=dev`) don't have `pino-pretty`, so the resolve check below fails
 * shut to JSON — there's no way to accidentally ship pretty logs to Cloud Run.
 *
 * This module must never `console.*` — the `no-console.test.ts` guard enforces
 * that across the runtime surface.
 */

import { createRequire } from 'node:module';

import pino, {
  type Logger,
  type LoggerOptions,
  type DestinationStream,
} from 'pino';

const require = createRequire(import.meta.url);

export type Severity = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/** Per-request correlation fields, bound via {@link AppLogger.child}. */
export interface LogContext {
  readonly uid?: string;
  readonly characterId?: string;
  readonly sessionId?: string;
  readonly traceId?: string;
}

/** Arbitrary structured fields attached to a single log line. */
export type LogFields = Record<string, unknown>;

/**
 * The geas-agent logger surface. `event` is the mandatory first arg on every
 * method (a kebab-case verb), keeping the `event=` filter dimension populated
 * on every line. Optional `fields` are sanitized before emission.
 */
export interface AppLogger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Bind correlation context for a request/session; returns a child logger. */
  child(context: LogContext): AppLogger;
  /** Escape hatch for the raw pino instance (e.g. `flush()` in tests). */
  readonly raw: Logger;
}

// ---------------------------------------------------------------------------
// Redaction + truncation
// ---------------------------------------------------------------------------

/** Max characters retained for a message-body-ish field. */
export const MAX_BODY_CHARS = 200;

/** Maximum object depth `sanitize` will walk before bailing. */
const MAX_DEPTH = 6;

/** Exact (lowercased) field names that must never be logged in the clear. */
const SECRET_KEYS = new Set([
  'authorization',
  'password',
  'secret',
  'clientsecret',
  'apikey',
  'api_key',
  'credential',
  'credentials',
  'cookie',
]);

/**
 * Lowercased field names whose string value is a body/content blob and must
 * be truncated to {@link MAX_BODY_CHARS}.
 */
const TRUNCATE_KEYS = new Set([
  'message',
  'body',
  'content',
  'text',
  'prompt',
  'completion',
  'usermessage',
  'assistantmessage',
  'narration',
]);

/**
 * A key is secret if it's in {@link SECRET_KEYS} or ends in `token`
 * (`refreshToken`, `idToken`, `accessToken`, `bearerToken`, `authToken`).
 * `tokens` / `tokenCount` / `totalTokens` are deliberately NOT matched — those
 * are usage counters, not credentials.
 */
function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  if (SECRET_KEYS.has(k)) return true;
  return k.endsWith('token');
}

function truncate(value: string, max = MAX_BODY_CHARS): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[+${value.length - max} chars]`;
}

/**
 * Deep-clone `input`, redacting secret-shaped keys and truncating body-shaped
 * string fields. Errors are converted to a safe `{ name, message, stack }`
 * shape (with a truncated message). Cycles are cut with `[Circular]`; depth is
 * capped to keep logging cheap and crash-proof on adversarial input.
 */
export function sanitize(
  input: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (input === null || typeof input !== 'object') return input;

  if (input instanceof Error) {
    return {
      name: input.name,
      message: truncate(input.message),
      stack: input.stack,
    };
  }

  if (seen.has(input)) return '[Circular]';
  seen.add(input);

  if (depth >= MAX_DEPTH) return Array.isArray(input) ? '[Array]' : '[Object]';

  if (Array.isArray(input)) {
    return input.map((v) => sanitize(v, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (isSecretKey(key)) {
      out[key] = '[REDACTED]';
    } else if (typeof value === 'string' && TRUNCATE_KEYS.has(key.toLowerCase())) {
      out[key] = truncate(value);
    } else {
      out[key] = sanitize(value, depth + 1, seen);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// pino wiring
// ---------------------------------------------------------------------------

const SEVERITY_BY_LEVEL: Record<string, Severity> = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
  fatal: 'ERROR',
};

function isProd(): boolean {
  return process.env.NODE_ENV === 'production';
}

function isTest(): boolean {
  return process.env.NODE_ENV === 'test' || !!process.env.VITEST;
}

/** Pretty only in local dev, only when `pino-pretty` is actually installed. */
function usePretty(): boolean {
  if (isProd() || isTest()) return false;
  if (process.env.GEAS_LOG_JSON === '1') return false;
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

function baseOptions(): LoggerOptions {
  return {
    level: process.env.GEAS_LOG_LEVEL ?? (isProd() ? 'info' : 'debug'),
    // Emit Cloud-Logging-style `severity` strings instead of pino's numeric
    // `level`. This is the field combat/levelup/tool-call queries filter on.
    formatters: {
      level: (label) => ({
        severity: SEVERITY_BY_LEVEL[label] ?? label.toUpperCase(),
      }),
    },
  };
}

function buildPino(destination?: DestinationStream): Logger {
  if (destination) return pino(baseOptions(), destination);
  if (usePretty()) {
    return pino({
      ...baseOptions(),
      transport: { target: 'pino-pretty', options: { colorize: true } },
    });
  }
  return pino(baseOptions());
}

function wrap(p: Logger): AppLogger {
  const emit = (
    level: 'debug' | 'info' | 'warn' | 'error',
    event: string,
    fields?: LogFields,
  ): void => {
    const clean = fields
      ? (sanitize(fields) as Record<string, unknown>)
      : undefined;
    // `event` last so a stray `event` key in `fields` can't shadow the verb.
    p[level]({ ...clean, event }, event);
  };

  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    child: (context) => wrap(p.child({ ...context })),
    raw: p,
  };
}

/**
 * Build a logger. Pass `destination` to capture output (tests); pass `context`
 * to pre-bind correlation fields. With no options you get the process default
 * (JSON to stdout, pretty in local dev).
 */
export function createLogger(opts?: {
  destination?: DestinationStream;
  context?: LogContext;
}): AppLogger {
  const p = buildPino(opts?.destination);
  return opts?.context ? wrap(p.child({ ...opts.context })) : wrap(p);
}

/** Process-wide default logger. Bind per-request context via `.child(...)`. */
export const logger: AppLogger = createLogger();
