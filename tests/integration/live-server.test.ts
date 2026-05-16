/**
 * Live integration test against a running geas-server MCP endpoint.
 *
 * Skipped by default (vitest.config.ts excludes `tests/integration/`); opt in
 * by running:
 *
 *   GEAS_LIVE_MCP_URL=http://localhost:8088/mcp \
 *   GEAS_LIVE_DEV_UID=nick-dev \
 *   npx vitest run tests/integration
 *
 * Prereq: a local geas-server running with `GEAS_DEV_UNAUTH=1` + matching
 * `GEAS_DEV_UID`. The test connects, calls `whoami`, asserts the response,
 * forces a transport drop, calls `whoami` again, and verifies the wrapper
 * reconnected transparently.
 *
 * If the env vars are unset the test is skipped (not failed) — this keeps
 * CI green when no live server is reachable. Niall's local + the deploy
 * smoke can both flip the env on to exercise the path.
 */

import { describe, it, expect } from 'vitest';
import { GeasMcpClient } from '../../src/mcp/index.js';

const LIVE_URL = process.env.GEAS_LIVE_MCP_URL;
const LIVE_UID = process.env.GEAS_LIVE_DEV_UID;

const liveDescribe = LIVE_URL ? describe : describe.skip;

liveDescribe('GeasMcpClient against a live geas-server', () => {
  it('connects, calls whoami, forces a drop, and reconnects', async () => {
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

      const before = await client.whoami();
      expect(before.ok).toBe(true);

      // Force a transport drop. The next call must reconnect transparently.
      await client._testForceDrop();
      expect(client.isConnected()).toBe(false);

      const after = await client.whoami();
      expect(after.ok).toBe(true);
      expect(client.isConnected()).toBe(true);

      // Also exercise look — the canonical observation tool.
      const look = await client.look();
      expect(look.ok).toBe(true);
    } finally {
      await client.disconnect();
    }
  }, 30_000);
});
