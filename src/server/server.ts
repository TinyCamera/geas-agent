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
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  PROTOCOL_VERSION,
  type ApiError,
  type ChannelAEvent,
  type ChatAccepted,
  type ChatRequest,
  type HistoryResponse,
  type HistoryTurn,
  type ListSessionsResponse,
  type ResolveDecisionRequest,
  type SyncChatResponse,
  type SyncChatTimeoutResponse,
} from './wire.js';
import { assembleTurn } from './assemble-turn.js';

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
  /**
   * Wait budget for `POST /chat/sync` (issue #736). Default 120_000 ms,
   * matching the `SYNC_CHAT_TIMEOUT_MS` env contract documented in the
   * ticket. Tests pass a tight value (e.g. 50ms) to exercise the
   * timeout branch deterministically.
   */
  readonly syncChatTimeoutMs?: number;
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
  const syncChatTimeoutMs = opts.syncChatTimeoutMs ?? 120_000;
  let nextSyncSubId = 1;

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

  app.get('/history', async (req, res) => {
    // Paginated conversation history for one (uid, characterId) — issue #775.
    // `before` is exclusive turnIndex; omit for the most recent page.
    // `limit` defaults to HISTORY_DEFAULT_LIMIT, capped at HISTORY_MAX_LIMIT.
    const token = bearer(req);
    if (!token) {
      res.status(401).json(apiError('unauthorized', 'missing bearer token'));
      return;
    }
    let uid: string;
    try {
      ({ uid } = await opts.verifier.verify(token));
    } catch (e) {
      res.status(401).json(apiError('unauthorized', (e as Error).message));
      return;
    }
    const characterId = typeof req.query.characterId === 'string'
      ? req.query.characterId
      : '';
    if (!characterId) {
      res
        .status(400)
        .json(apiError('bad_request', 'characterId query param is required'));
      return;
    }
    // `before` is optional (omit to fetch the most recent page) but if
    // supplied must parse as a non-negative integer. Reject garbage rather
    // than silently treating it as "most recent" — clients that mean
    // "most recent" should omit the param.
    let before = Number.POSITIVE_INFINITY;
    if (typeof req.query.before === 'string' && req.query.before !== '') {
      const parsed = Number(req.query.before);
      if (!Number.isFinite(parsed) || parsed < 0) {
        res
          .status(400)
          .json(
            apiError(
              'bad_request',
              "'before' must be a non-negative finite number",
            ),
          );
        return;
      }
      before = parsed;
    }
    let limit = HISTORY_DEFAULT_LIMIT as number;
    if (typeof req.query.limit === 'string' && req.query.limit !== '') {
      const parsed = Number(req.query.limit);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        res
          .status(400)
          .json(
            apiError('bad_request', "'limit' must be a positive number"),
          );
        return;
      }
      limit = Math.min(Math.floor(parsed), HISTORY_MAX_LIMIT);
    }
    if (!opts.store) {
      res
        .status(503)
        .json(apiError('unavailable', 'history not configured'));
      return;
    }
    try {
      // Over-fetch by one so we can tell `hasMore` without a second query.
      const overfetched = await opts.store.getOlderTurns(
        { uid, characterId },
        before,
        limit + 1,
      );
      const hasMore = overfetched.length > limit;
      // `getOlderTurns` returns ascending. `hasMore=true` means the
      // *oldest* entry in `overfetched` is the extra one — drop it.
      const turns = (hasMore ? overfetched.slice(1) : overfetched).map<HistoryTurn>(
        (t) => ({
          turnIndex: t.turnIndex,
          sessionId: t.sessionId,
          characterId: t.characterId,
          displayName: t.displayName,
          timestamp: t.timestamp,
          userMessage: t.userMessage,
          llmTurns: t.llmTurns.map((l) => ({
            intent: l.intent,
            toolCalls: l.toolCalls.map((c) => ({
              tool: c.tool,
              args: c.args,
              status: c.status,
              attempts: c.attempts,
            })),
            narration: l.narration,
          })),
          tokenUsage: { ...t.tokenUsage },
          totalCostUsd: t.totalCostUsd,
          ...(t.error !== undefined ? { error: t.error } : {}),
        }),
      );
      const body: HistoryResponse = {
        protocolVersion: PROTOCOL_VERSION,
        uid,
        characterId,
        turns,
        hasMore,
        ts: now(),
      };
      res.status(200).json(body);
    } catch (e) {
      res
        .status(500)
        .json(apiError('internal', `getOlderTurns failed: ${(e as Error).message}`));
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
      session.deliverUserMessage(message, { sessionId }).catch(() => {
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

  app.post('/chat/sync', async (req, res) => {
    // Synchronous variant of POST /chat (issue #736). Subscribes a
    // throwaway listener to the hub stream for (uid, characterId),
    // invokes `deliverUserMessage`, awaits the turn (with timeout),
    // assembles the captured events into a `TurnResult`, returns it.
    //
    // Streaming /chat stays untouched — this is purely additive.
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

    // Concurrency gate: if a turn is already running on this session's
    // (uid, characterId), 409 — don't queue. Clients retry.
    //
    // We key the gate on (uid, characterId) because that's where the
    // turn actually serializes inside `IdleSession`. `sessionId` is
    // opaque to the hub/registry (see session-registry.ts) and a single
    // user could legitimately re-use it across tabs.
    const existing = opts.registry.peek(uid, characterId);
    if (existing && existing.isTurnActive()) {
      res.status(409).json(
        apiError(
          'turn_in_progress',
          'another turn for this character is already running',
        ),
      );
      return;
    }

    const session = opts.registry.get(uid, characterId);

    // Subscribe a throwaway listener to capture every event the runner
    // emits during the turn. We start from the current `lastEventId`
    // so we don't replay history into this assembly.
    const startCursor = opts.hub.lastEventId(uid, characterId);
    const captured: ChannelAEvent[] = [];
    const subId = `sync-${nextSyncSubId++}`;
    let donePromiseResolve: (() => void) | null = null;
    const donePromise = new Promise<void>((resolve) => {
      donePromiseResolve = resolve;
    });
    opts.hub.subscribe(
      uid,
      characterId,
      {
        id: subId,
        send: (event) => {
          // Skip transport noise (hello/ping) — assembler filters too,
          // but keep the captured window tight.
          if (event.type === 'hello' || event.type === 'ping') return;
          captured.push(event);
          if (event.type === 'done' && donePromiseResolve) {
            donePromiseResolve();
            donePromiseResolve = null;
          }
        },
      },
      startCursor, // resume cursor — no replay; only new events
    );

    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, syncChatTimeoutMs);
    });

    try {
      // Kick the turn. `deliverUserMessage` resolves when the turn lands
      // in a terminal state, but we additionally race against an
      // explicit `done` event for cleaner cancellation semantics on
      // error paths.
      const turnPromise = session
        .deliverUserMessage(message, { sessionId })
        .catch((err: unknown) => {
          // Already surfaced as an `error` event on the stream — swallow
          // here so we still produce a structured response.
          captured.push({
            protocolVersion: PROTOCOL_VERSION,
            eventId: opts.hub.lastEventId(uid, characterId),
            ts: now(),
            uid,
            characterId,
            type: 'error',
            message: (err as Error).message ?? 'turn threw',
          });
        });

      await Promise.race([
        Promise.all([turnPromise, donePromise]),
        timeoutPromise,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      opts.hub.unsubscribe(uid, characterId, subId);
    }

    const turn = assembleTurn(message, captured, { timedOut });

    if (timedOut) {
      const body: SyncChatTimeoutResponse = {
        protocolVersion: PROTOCOL_VERSION,
        error: 'timeout',
        message: `turn did not complete within ${syncChatTimeoutMs}ms`,
        partialTurn: turn,
      };
      res.status(504).json(body);
      return;
    }

    const body: SyncChatResponse = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      characterId,
      ts: now(),
      turn,
    };
    res.status(200).json(body);
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
