/**
 * Auth verification for the Channel-A server (issue #667).
 *
 * `POST /chat` reads `Authorization: Bearer <id-token>`; `WS /events`
 * reads `?token=<id-token>` (browsers can't set headers on a WebSocket
 * upgrade). Both pass the token through a `TokenVerifier`.
 *
 * The default verifier uses firebase-admin's `auth().verifyIdToken()`.
 * Tests inject a fake verifier — we never want to hit Firebase during a
 * unit test.
 *
 * The verifier returns the user's `sub` (UID) on success. We do not
 * accept anonymous traffic in production; the dev harness can pass a
 * `StaticDevVerifier` keyed off `GEAS_DEV_UID` for offline runs.
 */

export interface TokenVerifier {
  /**
   * Verify the bearer token. Returns the UID on success, or rejects with
   * an `Error` whose message is safe to log (no token material).
   */
  verify(token: string): Promise<{ uid: string }>;
}

/** Always-fails verifier (default in tests that should not auth). */
export const REJECT_ALL_VERIFIER: TokenVerifier = {
  verify: async (_token: string) => {
    throw new Error('auth disabled');
  },
};

/**
 * Static verifier — accepts a fixed `{ token: uid }` map. Used by:
 *
 *  - Unit tests (deterministic UIDs, no Firebase).
 *  - Local dev with `GEAS_DEV_UID=...` and no Firebase project wired up.
 *
 * Do not enable in production.
 */
export class StaticDevVerifier implements TokenVerifier {
  readonly #table: ReadonlyMap<string, string>;
  constructor(entries: Iterable<readonly [token: string, uid: string]>) {
    this.#table = new Map(entries);
  }
  async verify(token: string): Promise<{ uid: string }> {
    const uid = this.#table.get(token);
    if (!uid) throw new Error('invalid token');
    return { uid };
  }
}

/**
 * Firebase Admin–backed verifier. Lazily reads from
 * `firebase-admin/auth`. We import dynamically to keep the server
 * usable in tests / scripts that don't initialise the SDK.
 */
export class FirebaseTokenVerifier implements TokenVerifier {
  async verify(token: string): Promise<{ uid: string }> {
    const mod = (await import('firebase-admin/auth')) as {
      getAuth: () => { verifyIdToken: (t: string) => Promise<{ uid: string }> };
    };
    const decoded = await mod.getAuth().verifyIdToken(token);
    return { uid: decoded.uid };
  }
}
