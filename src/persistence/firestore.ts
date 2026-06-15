/**
 * Firestore initialisation for geas-agent (#665).
 *
 * Mirrors `packages/mcp-server/src/firestore.ts` in geas-server — same env
 * triad (emulator / SA JSON / ADC), same `ignoreUndefinedProperties` setting,
 * same lazy singleton pattern.
 *
 * **Why a separate init in this repo.** geas-agent is a separate Node
 * process from the mcp-server; it can't share an `App` instance. Same env
 * conventions though, so an operator wiring credentials once gets both
 * processes working.
 */

import {
  initializeApp,
  cert,
  getApps,
  type App,
} from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

import { logger } from '../logging/logger.js';

let app: App | null = null;
let db: Firestore | null = null;

export function initFirestore(): Firestore {
  if (db) return db;

  if (getApps().length > 0) {
    app = getApps()[0];
    db = getFirestore(app);
    return db;
  }

  const emulator = process.env.FIRESTORE_EMULATOR_HOST;
  const projectId =
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    (emulator ? 'geas-rpg' : undefined);

  if (emulator) {
    logger.info('firestore-init', { mode: 'emulator', emulator, projectId });
    app = initializeApp({ projectId });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    logger.info('firestore-init', { mode: 'service-account' });
    app = initializeApp({
      credential: cert(process.env.GOOGLE_APPLICATION_CREDENTIALS),
    });
  } else if (projectId) {
    logger.info('firestore-init', { mode: 'adc', projectId });
    app = initializeApp({ projectId });
  } else {
    throw new Error(
      '[geas-agent] Firestore is not configured. Set FIRESTORE_EMULATOR_HOST (local dev), ' +
        'GOOGLE_APPLICATION_CREDENTIALS (local against prod), or run on Cloud Run with a ' +
        'service account that has Firestore access.',
    );
  }

  db = getFirestore(app);
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}

export function getDb(): Firestore {
  if (!db) {
    throw new Error(
      '[geas-agent] Firestore not initialized — call initFirestore() first',
    );
  }
  return db;
}

/** Reset hook — tests only. Does NOT delete underlying data. */
export function __resetFirestoreForTests(): void {
  app = null;
  db = null;
}
