/**
 * Channel-A HTTP + WebSocket server (issue #667).
 *
 * The user-facing API surface for the agent host.
 *
 * Routes:
 *   POST /chat              → enqueue a user message
 *   POST /resolve-decision  → user-side reply to a server-pushed decision
 *   GET  /healthz           → liveness probe
 *   WS   /events            → typed event stream (one per (uid,characterId))
 *
 * Auth:
 *   POST routes — `Authorization: Bearer <id-token>`
 *   WS route    — `?token=<id-token>` query param (browsers can't set
 *                 Authorization on a WebSocket upgrade)
 *
 * The server takes its `TokenVerifier`, `SessionRegistry`, and `EventHub`
 * as constructor inputs so:
 *   - Tests inject a `StaticDevVerifier` + fake session factory and run
 *     the whole stack in-process with no real LLM / MCP / Firebase.
 *   - Production wiring (a future `src/index-server.ts` entrypoint)
 *     wires the real Firebase verifier + real LoopRunner factory.
 */

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import express, { type Application, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import type { TokenVerifier } from './auth.js';
import type { EventHub, Subscriber } from './hub.js';
import type { SessionRegistry } from './session-registry.js';
import type { ConversationStore } from '../persistence/conversation-store.js';
import {
  PROTOCOL_VERSION,
  type ApiError,
  type ChatAccepted,
  type ChatRequest,
  type ListSessionsResponse,
  type ResolveDecisionRequest,
} from './wire.js';

export interface ServerOptions {
  readonly verifier: TokenVerifier;
  readonly registry: SessionRegistry;
  readonly hub: EventHub;
  /**
   * Conversation history store backing `GET /sessions` (#650). If omitted,
   * `GET /sessions` responds 503 — tests that don't exercise the listing
   * path can leave this out.
   */
  readonly store?: ConversationStore;
  /** Override Date.now() for tests. */
  readonly now?: () => number;
  /** Ping interval ms (default 30s, 0 disables). */
  readonly pingIntervalMs?: number;
}

export interface RunningServer {
  readonly app: Application;
  readonly httpServer: HttpServer;
  readonly wss: WebSocketServer;
  /** Resolves with the bound port. */
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

function bearer(req: Request): string | null {
  const h = req.header('authorization') ?? req.header('Authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

function send(
  res: Response,
  status: number,
  body: ChatAccepted | ApiError,
): void {
  res.status(status).json(body);
}

function apiError(error: string, message: string): ApiError {
  return { protocolVersion: PROTOCOL_VERSION, error, message };
}

function isChatRequest(body: unknown): body is ChatRequest {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.sessionId === 'string' &&
    typeof b.characterId === 'string' &&
    typeof b.message === 'string'
  );
}

function isResolveDecisionRequest(body: unknown): body is ResolveDecisionRequest {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.sessionId === 'string' &&
    typeof b.characterId === 'string' &&
    typeof b.decisionId === 'string' &&
    typeof b.text === 'string'
  );
}

export function createServer(opts: ServerOptions): RunningServer {
  const now = opts.now ?? (() => Date.now());
  const pingIntervalMs = opts.pingIntervalMs ?? 30_000;

  const app = express();
  app.use(express.json({ limit: '64kb' }));

  // ---- HTTP routes ----

  app.get('/sessions', async (req, res) => {
    const token = bearer(req);
    if (!token) {
      res
        .status(401)
        .json(apiError('unauthorized', 'missing bearer token'));
      return;
    }
    let uid: string;
    try {
      ({ uid } = await opts.verifier.verify(token));
    } catch (e) {
      res.status(401).json(apiError('unauthorized', (e as Error).message));
      return;
    }
    if (!opts.store) {
      res
        .status(503)
        .json(apiError('unavailable', 'session listing not configured'));
      return;
    }
    try {
      const sessions = await opts.store.listSessions(uid);
      const body: ListSessionsResponse = {
        protocolVersion: PROTOCOL_VERSION,
        uid,
        sessions: sessions.map((s) => ({
          sessionId: s.sessionId,
          characterId: s.characterId,
          displayName: s.displayName,
          lastActive: s.lastActive,
          turns: s.turns,
          totalCostUsd: s.totalCostUsd,
        })),
        ts: now(),
      };
      res.status(200).json(body);
    } catch (e) {
      res
        .status(500)
        .json(apiError('internal', `listSessions failed: ${(e as Error).message}`));
    }
  });

  app.get('/healthz', (_req, res) => {
    res.status(200).json({
      protocolVersion: PROTOCOL_VERSION,
      ok: true,
      ts: now(),
    });
  });

  app.post('/chat', async (req, res) => {
    const token = bearer(req);
    if (!token) {
      send(res, 401, apiError('unauthorized', 'missing bearer token'));
      return;
    }
    let uid: string;
    try {
      ({ uid } = await opts.verifier.verify(token));
    } catch (e) {
      send(res, 401, apiError('unauthorized', (e as Error).message));
      return;
    }
    if (!isChatRequest(req.body)) {
      send(
        res,
        400,
        apiError('bad_request', 'expected {sessionId, characterId, message}'),
      );
      return;
    }
    const { sessionId, characterId, message } = req.body;
    if (!message.trim()) {
      send(res, 400, apiError('bad_request', 'message must be non-empty'));
      return;
    }

    // Get-or-create the session and fire the user message. We do NOT
    // await the turn — the API contract is 202 Accepted + events stream
    // back over the WS.
    const session = opts.registry.get(uid, characterId);
    // Errors during the turn surface as `error` events on the WS, not on
    // the POST response. A throw from `deliverUserMessage` only happens
    // if the session was closed — treat as 409.
    queueMicrotask(() => {
      session.deliverUserMessage(message).catch(() => {
        // Already surfaced as a runner emit-event; nothing more to do.
      });
    });

    const body: ChatAccepted = {
      protocolVersion: PROTOCOL_VERSION,
      accepted: true,
      sessionId,
      characterId,
      ts: now(),
    };
    res.status(202).json(body);
  });

  app.post('/resolve-decision', async (req, res) => {
    const token = bearer(req);
    if (!token) {
      send(res, 401, apiError('unauthorized', 'missing bearer token'));
      return;
    }
    let uid: string;
    try {
      ({ uid } = await opts.verifier.verify(token));
    } catch (e) {
      send(res, 401, apiError('unauthorized', (e as Error).message));
      return;
    }
    if (!isResolveDecisionRequest(req.body)) {
      send(
        res,
        400,
        apiError(
          'bad_request',
          'expected {sessionId, characterId, decisionId, text}',
        ),
      );
      return;
    }
    const session = opts.registry.peek(uid, req.body.characterId);
    if (!session) {
      send(res, 404, apiError('not_found', 'no active session for character'));
      return;
    }
    // The session's runner owns the decision queue. We forward via the
    // session, which routes to the active runner or wakes a fresh one
    // with the framed text.
    session.deliverDecision(req.body.decisionId, req.body.text);
    const body: ChatAccepted = {
      protocolVersion: PROTOCOL_VERSION,
      accepted: true,
      sessionId: req.body.sessionId,
      characterId: req.body.characterId,
      ts: now(),
    };
    res.status(202).json(body);
  });

  // ---- HTTP + WS plumbing ----

  const httpServer = createHttpServer(app);
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/events') {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('token');
    const characterId = url.searchParams.get('characterId');
    const lastEventIdStr = url.searchParams.get('lastEventId');
    if (!token || !characterId) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    opts.verifier.verify(token).then(
      ({ uid }) => {
        wss.handleUpgrade(req, socket, head, (ws) => {
          attachSocket(ws, {
            uid,
            characterId,
            since: Number.parseInt(lastEventIdStr ?? '0', 10) || 0,
          });
        });
      },
      () => {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
      },
    );
  });

  let nextSubId = 1;
  const pingTimers: Set<NodeJS.Timeout> = new Set();

  function attachSocket(
    ws: WebSocket,
    ctx: { uid: string; characterId: string; since: number },
  ): void {
    const subId = `sub-${nextSubId++}`;
    const subscriber: Subscriber = {
      id: subId,
      send: (event) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify(event));
        }
      },
    };

    const { resumeCursor } = opts.hub.subscribe(
      ctx.uid,
      ctx.characterId,
      subscriber,
      ctx.since,
    );

    // Send hello once the subscriber is wired.
    opts.hub.sendDirect(subscriber, {
      protocolVersion: PROTOCOL_VERSION,
      eventId: resumeCursor,
      ts: now(),
      uid: ctx.uid,
      characterId: ctx.characterId,
      type: 'hello',
      serverProtocolVersion: PROTOCOL_VERSION,
      resumeCursor,
    });

    let pingTimer: NodeJS.Timeout | null = null;
    if (pingIntervalMs > 0) {
      pingTimer = setInterval(() => {
        opts.hub.sendDirect(subscriber, {
          protocolVersion: PROTOCOL_VERSION,
          eventId: opts.hub.lastEventId(ctx.uid, ctx.characterId),
          ts: now(),
          uid: ctx.uid,
          characterId: ctx.characterId,
          type: 'ping',
        });
      }, pingIntervalMs);
      pingTimers.add(pingTimer);
    }

    const cleanup = (): void => {
      opts.hub.unsubscribe(ctx.uid, ctx.characterId, subId);
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimers.delete(pingTimer);
      }
    };

    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }

  // ---- lifecycle ----

  async function listen(port = 0): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, () => {
        const addr = httpServer.address();
        if (addr && typeof addr === 'object') resolve(addr.port);
        else reject(new Error('listen: no address bound'));
      });
    });
  }

  async function close(): Promise<void> {
    for (const t of pingTimers) clearInterval(t);
    pingTimers.clear();
    // Close all WS connections.
    for (const client of wss.clients) {
      try {
        client.close(1001, 'server closing');
      } catch {
        // ignore
      }
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      httpServer.close((err) => (err ? reject(err) : resolve())),
    );
  }

  return { app, httpServer, wss, listen, close };
}
