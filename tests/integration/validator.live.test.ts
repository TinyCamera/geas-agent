/**
 * Live integration test for the pre-dispatch validator (#658).
 *
 * Connects to a real geas-server MCP endpoint, lets the wrapper cache the
 * real `inputSchema` advertised over the wire, then drives:
 *
 *   - A known-good `look()` — must succeed (validator passes through).
 *   - A misspelled tool name — must fail locally with `unknown_tool` and
 *     NEVER round-trip the server (we assert the error kind is the local
 *     one, not a `tool_error` returned by the server).
 *   - A wrong-type argument — for `nearest({maxDist:'far'})`, the server
 *     would normally Zod-reject as a `tool_error`; the validator should
 *     beat the server to it and return `wrong_type` directly.
 *
 * Skipped by default (vitest.config.ts excludes tests/integration/). Opt in:
 *
 *   GEAS_LIVE_MCP_URL=http://localhost:8088/mcp \
 *   GEAS_LIVE_DEV_UID=nick-dev \
 *   npm run test:integration
 *
 * Requires geas-server running with `GEAS_DEV_UNAUTH=1`.
 */

import { describe, it, expect } from 'vitest';
import { GeasMcpClient } from '../../src/mcp/index.js';

const LIVE_URL = process.env.GEAS_LIVE_MCP_URL;
const LIVE_UID = process.env.GEAS_LIVE_DEV_UID;

const liveDescribe = LIVE_URL ? describe : describe.skip;

liveDescribe('validator against a live geas-server', () => {
  it('passes valid calls, blocks broken ones locally', async () => {
    const client = new GeasMcpClient({
      url: LIVE_URL!,
      devUid: LIVE_UID,
      reconnectBaseMs: 50,
      reconnectMaxMs: 1_000,
      reconnectMaxAttempts: 3,
    });
    try {
      const connected = await client.connect();
      expect(connected.ok).toBe(true);

      // 1. Known-good: look() returns ok.
      const look = await client.look();
      expect(look.ok).toBe(true);

      // 2. Unknown tool — must fail LOCALLY (no server round-trip). The
      //    distinguishing signal is `kind: 'unknown_tool'`; if the validator
      //    weren't wired, the server would respond with a generic JSON-RPC
      //    error surfaced as `transport` or `tool_error`.
      const bogus = await client.callTool('lok', {});
      expect(bogus.ok).toBe(false);
      if (!bogus.ok) expect(bogus.error.kind).toBe('unknown_tool');

      // 3. Wrong-type arg — `nearest` declares `maxDist: number`. Passing a
      //    string must be rejected locally as `wrong_type`. If this flips to
      //    `tool_error`, the validator didn't catch it and we round-tripped.
      const badType = await client.callTool('nearest', { maxDist: 'far' });
      expect(badType.ok).toBe(false);
      if (!badType.ok) expect(badType.error.kind).toBe('wrong_type');
    } finally {
      await client.disconnect();
    }
  }, 30_000);
});
