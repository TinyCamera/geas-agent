/**
 * Per-(uid, characterId) `IdleSession` registry (issue #667).
 *
 * The HTTP/WS server keeps no Colyseus-style room state of its own —
 * it asks the registry "give me the session for this user + character;
 * lazily create one if it doesn't exist", then forwards user messages
 * to it. Sessions live for the lifetime of the process; #592/#665
 * already persist the conversation underneath, so a process restart
 * loses only in-flight events (which the ring buffer wouldn't have
 * survived either).
 *
 * **Lazy creation.** A user might open the WS before sending their
 * first message — we mint the session at first `POST /chat`, not at
 * subscribe time. (Subscribers can attach to a stream that has no
 * session yet — they'll just receive nothing until activity starts.
 * The hub holds the buffer; the session is what *produces* events.)
 *
 * **No cross-user fan-out.** The key is `(uid, characterId)`. A WS
 * client authenticated as `uid=A` cannot subscribe to `uid=B`'s
 * stream — the route handler in `index.ts` enforces it.
 */

import type { IdleSession } from '../loop/session.js';

export interface SessionFactory {
  (uid: string, characterId: string): IdleSession;
}

export class SessionRegistry {
  readonly #sessions = new Map<string, IdleSession>();
  readonly #factory: SessionFactory;

  constructor(factory: SessionFactory) {
    this.#factory = factory;
  }

  /** Get-or-create the session for `(uid, characterId)`. */
  get(uid: string, characterId: string): IdleSession {
    const key = `${uid}:${characterId}`;
    let s = this.#sessions.get(key);
    if (!s) {
      s = this.#factory(uid, characterId);
      this.#sessions.set(key, s);
    }
    return s;
  }

  /** Look up without creating (used by tests + telemetry probes). */
  peek(uid: string, characterId: string): IdleSession | null {
    return this.#sessions.get(`${uid}:${characterId}`) ?? null;
  }

  /** Tear down a single session. Idempotent. */
  async drop(uid: string, characterId: string): Promise<void> {
    const key = `${uid}:${characterId}`;
    const s = this.#sessions.get(key);
    if (!s) return;
    this.#sessions.delete(key);
    await s.close();
  }

  /** Tear down all sessions. Called on server shutdown. */
  async closeAll(): Promise<void> {
    const all = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(all.map((s) => s.close()));
  }

  /** Telemetry / tests. */
  get size(): number {
    return this.#sessions.size;
  }
}
