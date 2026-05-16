/**
 * Tiny helpers shared by scenarios. Kept in their own module so scenario files
 * stay readable and the tests for these helpers don't have to import a whole
 * scenario module.
 */

import type { GeasToolResponse, Result, GeasMcpError } from '../mcp/index.js';

/**
 * Extract `structuredContent` from a wrapper response. Returns `null` when the
 * server returned only text content (some tools do, e.g. `whoami` always has
 * structured, but `chat` may not).
 */
export function structured<T = Record<string, unknown>>(
  resp: GeasToolResponse,
): T | null {
  return (resp.structuredContent as T | undefined) ?? null;
}

/** Pull the first text content from a response, or `''` if none. */
export function firstText(resp: GeasToolResponse): string {
  const item = resp.content?.find((c) => c.type === 'text');
  return typeof item?.text === 'string' ? item.text : '';
}

/**
 * Unwrap a `Result<GeasToolResponse>` to its value or throw a labeled error.
 * Scenarios use this when they cannot meaningfully continue past a failed
 * call — the runner catches and surfaces the message.
 */
export function unwrap<T>(label: string, r: Result<T>): T {
  if (!r.ok) {
    const e = r.error as GeasMcpError;
    throw new Error(`${label} failed: ${e.kind} — ${e.message}`);
  }
  return r.value;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
