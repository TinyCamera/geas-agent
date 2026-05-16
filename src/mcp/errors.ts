/**
 * Typed error contract for {@link GeasMcpClient}.
 *
 * The wrapper never throws on transport / RPC failures — callers always get a
 * discriminated `Result<T, GeasMcpError>` and decide what to do. This keeps
 * agent loops deterministic and easy to drive in tests.
 *
 * Error categories:
 *   - `not_connected`   — `callTool` invoked before / after a successful connect.
 *   - `transport`       — network / SSE / HTTP-level failure, including 5xx.
 *   - `unauthorized`    — 401 / `UnauthorizedError` from the SDK.
 *   - `tool_error`      — server returned `isError: true` in the CallToolResult.
 *   - `invalid_response`— server returned a payload we couldn't parse.
 *   - `timeout`         — request exceeded the configured wall budget.
 *   - `aborted`         — caller aborted via AbortSignal.
 */
export type GeasMcpErrorKind =
  | 'not_connected'
  | 'transport'
  | 'unauthorized'
  | 'tool_error'
  | 'invalid_response'
  | 'timeout'
  | 'aborted';

export interface GeasMcpError {
  readonly kind: GeasMcpErrorKind;
  readonly message: string;
  /** Original error if one was caught — for logging only, not for control flow. */
  readonly cause?: unknown;
  /** Tool name when known, for error attribution. */
  readonly tool?: string;
}

export type Ok<T> = { ok: true; value: T };
export type Err = { ok: false; error: GeasMcpError };
export type Result<T> = Ok<T> | Err;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err(error: GeasMcpError): Err {
  return { ok: false, error };
}

export function makeError(
  kind: GeasMcpErrorKind,
  message: string,
  opts: { cause?: unknown; tool?: string } = {},
): GeasMcpError {
  return { kind, message, cause: opts.cause, tool: opts.tool };
}
