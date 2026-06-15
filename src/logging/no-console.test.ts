/**
 * Guard: no `console.*` in the deployed runtime surface (#680).
 *
 * The ticket asks for a lint rule that fails any `console.log` in non-test
 * code. geas-agent's `lint` script is `tsc --noEmit` (no ESLint toolchain),
 * and the repo already self-guards behaviours via vitest tests in the default
 * `npm test` gate (e.g. `verify/runner.test.ts`). Rather than pull in a whole
 * ESLint setup for one rule, this test enforces the same invariant in the same
 * gate: anything that runs inside the long-lived agent process logs through the
 * structured logger, so Cloud Logging stays JSON-parseable.
 *
 * **Scope.** Human-facing CLI / dev tooling (the REPL, scenario runner,
 * verification harness, dev banner) is allowed to write to a terminal — those
 * are not the deployed Cloud Run process and JSON logging there would be
 * actively unhelpful. Everything else (server, persistence, loop, mcp, llm,
 * prompts, the server entrypoint) must use the logger.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));

/** Paths (relative to `src/`) exempt from the no-console rule. */
const ALLOW: readonly RegExp[] = [
  /\.test\.ts$/, // test files
  /^index\.ts$/, // dev banner / interactive launcher
  /^repl\//, // terminal REPL client
  /^scenarios\//, // scenario CLI + capture-friendly scenario logger
  /^verify\//, // verification harness CLI + tooling
];

/** Matches an actual console method call, not the word in a comment. */
const CONSOLE_CALL = /\bconsole\.(log|info|warn|error|debug|trace)\s*\(/;

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, acc);
    } else if (entry.endsWith('.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

describe('no console.* in the deployed runtime surface', () => {
  it('every runtime .ts file logs through the structured logger', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR)) {
      const rel = relative(SRC_DIR, file);
      if (ALLOW.some((re) => re.test(rel))) continue;
      const src = readFileSync(file, 'utf8');
      src.split('\n').forEach((line, i) => {
        if (CONSOLE_CALL.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(
      offenders,
      `console.* found in runtime code — use the logger from src/logging/logger.ts:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
