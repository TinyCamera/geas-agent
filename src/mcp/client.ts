/**
 * GeasMcpClient — thin wrapper over the MCP SDK Client for talking to the
 * geas-server MCP endpoint (Streamable HTTP transport).
 *
 * Design choices:
 *
 *   1. **No exceptions on the happy/transport path.** Every `callTool` returns
 *      `Result<GeasToolResponse>`. Agent loops are easier to reason about when
 *      failures are values; throws stay reserved for genuine programmer errors
 *      (e.g. constructing with bad config).
 *
 *   2. **Wrapper-level reconnect on top of SDK transport.** The SDK's
 *      StreamableHTTP transport handles SSE-stream reconnection itself, but a
 *      *request* that lands while the transport is mid-drop will still reject.
 *      We catch transport-class failures from `callTool`, tear down + rebuild
 *      the transport, and retry with capped exponential backoff
 *      (`baseDelayMs * 2^attempt`, jittered, capped at `maxDelayMs`).
 *
 *   3. **Drift detection at connect time.** After `initialize`, we call
 *      `listTools()` once and verify every name in `GEAS_TOOL_NAMES` is
 *      present. Missing names → connect returns `Err({kind:'invalid_response'})`
 *      so the caller knows immediately. Extra names → logged via the optional
 *      `onWarning` hook but not fatal (server can ship new tools without
 *      blocking older wrapper builds).
 *
 *   4. **devUid is informational.** Real auth uses either a bearer token
 *      (prod) or relies on the server's `GEAS_DEV_UNAUTH=1` bypass (local).
 *      `devUid` is sent as `X-Geas-Dev-Uid` so server logs attribute the
 *      session, but the server's auth middleware doesn't read it.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

import {
  type GeasMcpError,
  type Result,
  err,
  ok,
  makeError,
} from './errors.js';
import type { AgentBinding } from '../binding/index.js';
import {
  GEAS_TOOL_NAMES,
  type GeasToolName,
  type GeasToolResponse,
  type ActArgs,
  type AllocateStatsArgs,
  type BuyItemArgs,
  type ChatArgs,
  type ChooseLevelupArgs,
  type CreateCharacterArgs,
  type EntitiesArgs,
  type NearestArgs,
  type SellItemArgs,
  type SetPositionArgs,
  type SwitchCharacterArgs,
} from './tools.js';

export interface GeasMcpClientOptions {
  /** Full URL to the MCP endpoint, e.g. `http://localhost:8088/mcp`. */
  url: string;
  /** Optional dev UID — sent as `X-Geas-Dev-Uid` for log attribution. */
  devUid?: string;
  /** OAuth bearer token for prod. Sent as `Authorization: Bearer <token>`. */
  bearerToken?: string;
  /** Wrapper client name advertised in `initialize`. */
  clientName?: string;
  /** Wrapper client version advertised in `initialize`. */
  clientVersion?: string;
  /** Reconnect base delay in ms (default 250). */
  reconnectBaseMs?: number;
  /** Reconnect cap in ms (default 30_000). */
  reconnectMaxMs?: number;
  /** Max retry attempts per call before giving up (default 5). */
  reconnectMaxAttempts?: number;
  /** Per-call wall budget in ms (default 30_000). 0 disables. */
  requestTimeoutMs?: number;
  /** Hook for non-fatal warnings (e.g. unknown tool surfaced on connect). */
  onWarning?: (message: string, detail?: unknown) => void;
  /**
   * Transport factory override — used by tests to inject in-memory transports.
   * If provided, `url` / `devUid` / `bearerToken` are ignored for transport
   * construction (but still surfaced to consumers via getters).
   */
  transportFactory?: () => Transport;
  /**
   * The agent's binding context — which character this process is driving and
   * under what mode. When set, every `callTool` invocation carries the binding
   * fields under an `_agentBinding` key inside the tool args; the wrapper also
   * advertises the binding via `X-Geas-Agent-Entity` / `X-Geas-Agent-Mode`
   * headers on the underlying StreamableHTTP transport so server-side logs +
   * future per-request enforcement (today the enforcement gate is on the
   * EntitySchema's `bindingMode`, set at character creation — but logs / drift
   * detection benefit from per-request visibility too).
   *
   * Bindings are constructed via `createBinding()` from the `binding` module;
   * see that file for the design rationale.
   */
  binding?: AgentBinding;
}

type ResolvedOptions = Required<
  Omit<
    GeasMcpClientOptions,
    'devUid' | 'bearerToken' | 'onWarning' | 'transportFactory' | 'binding'
  >
> & {
  devUid?: string;
  bearerToken?: string;
  onWarning: (message: string, detail?: unknown) => void;
  transportFactory?: () => Transport;
  binding?: AgentBinding;
};

const DEFAULTS = {
  clientName: 'geas-agent',
  clientVersion: '0.1.0',
  reconnectBaseMs: 250,
  reconnectMaxMs: 30_000,
  reconnectMaxAttempts: 5,
  requestTimeoutMs: 30_000,
} as const;

export class GeasMcpClient {
  private readonly opts: ResolvedOptions;
  private client: Client | null = null;
  private transport: Transport | null = null;
  private connecting: Promise<Result<void>> | null = null;
  private closed = false;
  /**
   * Set of tool names the server advertised at connect time. Populated by
   * the connect-time drift check. Callers use `hasTool()` to probe optional
   * dev-only tools (e.g. `set_position`, see #632) without paying the cost
   * of a failed `callTool` round-trip when the tool isn't registered (the
   * MCP SDK surfaces "unknown tool" as a generic JSON-RPC error which is
   * harder to branch on cleanly).
   */
  private serverTools = new Set<string>();

  constructor(options: GeasMcpClientOptions) {
    if (!options.url && !options.transportFactory) {
      throw new Error('GeasMcpClient: `url` (or `transportFactory`) required');
    }
    this.opts = {
      url: options.url,
      clientName: options.clientName ?? DEFAULTS.clientName,
      clientVersion: options.clientVersion ?? DEFAULTS.clientVersion,
      reconnectBaseMs: options.reconnectBaseMs ?? DEFAULTS.reconnectBaseMs,
      reconnectMaxMs: options.reconnectMaxMs ?? DEFAULTS.reconnectMaxMs,
      reconnectMaxAttempts:
        options.reconnectMaxAttempts ?? DEFAULTS.reconnectMaxAttempts,
      requestTimeoutMs:
        options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
      devUid: options.devUid,
      bearerToken: options.bearerToken,
      onWarning: options.onWarning ?? (() => {}),
      transportFactory: options.transportFactory,
      binding: options.binding,
    };
  }

  /**
   * The current binding (or `undefined` if the client was constructed without
   * one). Bindings are immutable values — to change which character this
   * client drives, build a new `GeasMcpClient` with a fresh binding rather
   * than mutating in place. Single-character per process is the documented
   * constraint (see `binding/binding.ts`).
   */
  get binding(): AgentBinding | undefined {
    return this.opts.binding;
  }

  /** True when connected to the server and the tool surface check passed. */
  isConnected(): boolean {
    return this.client !== null && !this.closed;
  }

  /**
   * True when the server advertised tool `name` at connect time. Use this
   * to probe optional dev-only tools (e.g. `set_position`) before calling
   * them — the tool is only registered when geas-server runs with
   * `GEAS_DEV_UNAUTH=1`, so production connections will not have it. Returns
   * `false` before the first successful `connect()`.
   */
  hasTool(name: string): boolean {
    return this.serverTools.has(name);
  }

  /**
   * Connect to the MCP endpoint. Idempotent: concurrent callers share the
   * same in-flight promise. After resolve, `isConnected()` is true and the
   * tool surface has been validated.
   */
  async connect(): Promise<Result<void>> {
    if (this.closed) {
      return err(makeError('not_connected', 'client has been disconnected'));
    }
    if (this.client) return ok(undefined);
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      try {
        const transport = this.buildTransport();
        const client = new Client(
          { name: this.opts.clientName, version: this.opts.clientVersion },
          { capabilities: {} },
        );
        await client.connect(transport);
        // Drift check — fail loudly on missing tools, warn on extras.
        const surface = await client.listTools();
        const present = new Set(surface.tools.map((t) => t.name));
        this.serverTools = present;
        const missing = GEAS_TOOL_NAMES.filter((n) => !present.has(n));
        if (missing.length > 0) {
          await safeClose(client, transport);
          return err(
            makeError(
              'invalid_response',
              `server is missing expected tools: ${missing.join(', ')}`,
            ),
          );
        }
        const extras = [...present].filter(
          (n) => !(GEAS_TOOL_NAMES as readonly string[]).includes(n),
        );
        if (extras.length > 0) {
          this.opts.onWarning(
            `server exposes tools unknown to this wrapper (drift): ${extras.join(', ')}`,
          );
        }
        this.client = client;
        this.transport = transport;
        return ok(undefined);
      } catch (e) {
        return err(classifyError(e));
      } finally {
        this.connecting = null;
      }
    })();

    return this.connecting;
  }

  /** Tear down the transport + client. Safe to call repeatedly. */
  async disconnect(): Promise<void> {
    this.closed = true;
    const c = this.client;
    const t = this.transport;
    this.client = null;
    this.transport = null;
    if (c || t) await safeClose(c, t);
  }

  /**
   * Force-tear-down the underlying transport without flipping `closed`. The
   * next call will trigger a reconnect via `ensureConnected`. Exposed for
   * tests that need to simulate a drop; production reconnect happens
   * automatically inside `callTool`.
   */
  async _testForceDrop(): Promise<void> {
    const c = this.client;
    const t = this.transport;
    this.client = null;
    this.transport = null;
    if (c || t) await safeClose(c, t);
  }

  /**
   * Call a tool by name. Returns `{ok: true, value}` on success (including
   * `isError: true` payloads from the *tool itself* — those become
   * `kind:'tool_error'` Err). Transport failures trigger reconnect + retry
   * with capped exponential backoff up to `reconnectMaxAttempts`.
   */
  async callTool(
    name: GeasToolName | (string & {}),
    args: Record<string, unknown> = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<Result<GeasToolResponse>> {
    if (this.closed) {
      return err(
        makeError('not_connected', 'client has been disconnected', { tool: name }),
      );
    }

    let lastErr: GeasMcpError | null = null;
    for (let attempt = 0; attempt <= this.opts.reconnectMaxAttempts; attempt++) {
      if (options.signal?.aborted) {
        return err(makeError('aborted', 'call aborted', { tool: name }));
      }

      const connected = await this.ensureConnected();
      if (!connected.ok) {
        lastErr = connected.error;
        // Connection failures are usually transport-class; let the loop retry
        // them up to the cap. Unauthorized is fatal — no point retrying.
        if (connected.error.kind === 'unauthorized') {
          return err({ ...connected.error, tool: name });
        }
      } else {
        const client = this.client!;
        try {
          const raw = await callWithTimeout(
            client.callTool({ name, arguments: this.injectBinding(args) }),
            this.opts.requestTimeoutMs,
            options.signal,
          );
          const resp = raw as GeasToolResponse;
          if (resp?.isError) {
            // Tool-reported error — the server completed the round trip but
            // the tool failed (validation, business rule, etc.). Not a retry
            // candidate; return immediately so the agent can react.
            const text = firstText(resp) ?? 'tool reported error';
            return err(makeError('tool_error', text, { tool: name, cause: resp }));
          }
          return ok(resp);
        } catch (e) {
          lastErr = classifyError(e, name);
          if (lastErr.kind === 'unauthorized' || lastErr.kind === 'aborted') {
            return err(lastErr);
          }
          // Tear down so the next attempt rebuilds the transport.
          await this._testForceDrop();
        }
      }

      if (attempt < this.opts.reconnectMaxAttempts) {
        const delay = this.backoffDelay(attempt);
        const waited = await sleep(delay, options.signal);
        if (!waited) return err(makeError('aborted', 'call aborted', { tool: name }));
      }
    }
    return err(
      lastErr ??
        makeError('transport', 'exhausted reconnect attempts', { tool: name }),
    );
  }

  /**
   * Snapshot of the live tool surface. Useful for diagnostics and for tests
   * that want to assert against the canonical server-side schema rather than
   * the wrapper's hand-written list.
   */
  async listTools(): Promise<Result<{ name: string; description?: string }[]>> {
    const c = await this.ensureConnected();
    if (!c.ok) return err(c.error);
    try {
      const r = await this.client!.listTools();
      return ok(r.tools.map((t) => ({ name: t.name, description: t.description })));
    } catch (e) {
      return err(classifyError(e));
    }
  }

  // ---------------------------------------------------------------------------
  // Typed convenience methods — thin wrappers over callTool with shaped args.
  // ---------------------------------------------------------------------------

  look(signal?: AbortSignal) {
    return this.callTool('look', {}, { signal });
  }
  status(signal?: AbortSignal) {
    return this.callTool('status', {}, { signal });
  }
  whoami(signal?: AbortSignal) {
    return this.callTool('whoami', {}, { signal });
  }
  act(args: ActArgs, signal?: AbortSignal) {
    return this.callTool('act', args, { signal });
  }
  nearest(args: NearestArgs = {}, signal?: AbortSignal) {
    return this.callTool('nearest', toRecord(args), { signal });
  }
  entities(args: EntitiesArgs = {}, signal?: AbortSignal) {
    return this.callTool('entities', toRecord(args), { signal });
  }
  build(signal?: AbortSignal) {
    return this.callTool('build', {}, { signal });
  }
  map(signal?: AbortSignal) {
    return this.callTool('map', {}, { signal });
  }
  chat(args: ChatArgs, signal?: AbortSignal) {
    return this.callTool('chat', toRecord(args), { signal });
  }
  allocateStats(args: AllocateStatsArgs, signal?: AbortSignal) {
    return this.callTool('allocate_stats', toRecord(args), { signal });
  }
  chooseLevelup(args: ChooseLevelupArgs, signal?: AbortSignal) {
    return this.callTool('choose_levelup', toRecord(args), { signal });
  }
  buyItem(args: BuyItemArgs, signal?: AbortSignal) {
    return this.callTool('buy_item', toRecord(args), { signal });
  }
  sellItem(args: SellItemArgs, signal?: AbortSignal) {
    return this.callTool('sell_item', toRecord(args), { signal });
  }
  createCharacter(args: CreateCharacterArgs, signal?: AbortSignal) {
    return this.callTool('create_character', toRecord(args), { signal });
  }
  switchCharacter(args: SwitchCharacterArgs, signal?: AbortSignal) {
    return this.callTool('switch_character', toRecord(args), { signal });
  }
  /**
   * Dev-only teleport (#632). Probe with `hasTool('set_position')` first —
   * the server only registers this tool when running with `GEAS_DEV_UNAUTH=1`
   * (prod will not have it). Failure modes the server surfaces as typed
   * `errorCode`: `out_of_bounds`, `tile_blocked`, `in_combat`, `invalid`,
   * `not_available`, `player_not_found`.
   */
  setPosition(args: SetPositionArgs, signal?: AbortSignal) {
    return this.callTool('set_position', toRecord(args), { signal });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async ensureConnected(): Promise<Result<void>> {
    if (this.client) return ok(undefined);
    return this.connect();
  }

  private buildTransport(): Transport {
    if (this.opts.transportFactory) return this.opts.transportFactory();
    const headers: Record<string, string> = {};
    if (this.opts.bearerToken) headers['Authorization'] = `Bearer ${this.opts.bearerToken}`;
    if (this.opts.devUid) headers['X-Geas-Dev-Uid'] = this.opts.devUid;
    if (this.opts.binding) {
      // Advertise the binding to the server for log attribution. Server-side
      // enforcement today reads `bindingMode` from the EntitySchema (see
      // `geas-server/packages/server/src/rooms/GameRoom.ts`), so these headers
      // are informational — but they make per-request audit possible and give
      // future per-request enforcement a hook without another wrapper bump.
      headers['X-Geas-Agent-Entity'] = this.opts.binding.entityId;
      headers['X-Geas-Agent-Owner'] = this.opts.binding.ownerUid;
      headers['X-Geas-Agent-Mode'] = this.opts.binding.bindingMode;
    }
    return new StreamableHTTPClientTransport(new URL(this.opts.url), {
      requestInit: { headers },
    });
  }

  /**
   * Augment outgoing tool args with the binding context under a reserved
   * `_agentBinding` key. The geas-server MCP layer ignores unknown args today
   * (every tool's Zod schema only validates declared fields), so this is
   * forward-compatible: when server-side per-request enforcement lands it can
   * read the envelope, and until then the field is harmless. Callers that
   * happen to use `_agentBinding` for their own purposes get their value
   * preserved — the binding does not silently overwrite.
   */
  private injectBinding(args: Record<string, unknown>): Record<string, unknown> {
    if (!this.opts.binding) return args;
    if ('_agentBinding' in args) return args;
    return {
      ...args,
      _agentBinding: {
        entityId: this.opts.binding.entityId,
        ownerUid: this.opts.binding.ownerUid,
        bindingMode: this.opts.binding.bindingMode,
      },
    };
  }

  private backoffDelay(attempt: number): number {
    const exp = this.opts.reconnectBaseMs * Math.pow(2, attempt);
    const capped = Math.min(exp, this.opts.reconnectMaxMs);
    // Full jitter, per AWS Architecture Blog — keeps clients from
    // synchronizing reconnect storms after a server restart.
    return Math.floor(Math.random() * capped);
  }
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function toRecord<T extends object>(args: T): Record<string, unknown> {
  return args as unknown as Record<string, unknown>;
}

function classifyError(e: unknown, tool?: string): GeasMcpError {
  if (e instanceof UnauthorizedError) {
    return makeError('unauthorized', e.message || 'unauthorized', { cause: e, tool });
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/abort/i.test(msg)) {
    return makeError('aborted', msg, { cause: e, tool });
  }
  if (/timeout/i.test(msg)) {
    return makeError('timeout', msg, { cause: e, tool });
  }
  return makeError('transport', msg, { cause: e, tool });
}

function firstText(resp: GeasToolResponse): string | undefined {
  const item = resp?.content?.find((c) => c.type === 'text');
  return item?.text;
}

async function safeClose(client: Client | null, transport: Transport | null) {
  try {
    await client?.close();
  } catch {
    /* ignore */
  }
  try {
    await transport?.close();
  } catch {
    /* ignore */
  }
}

async function callWithTimeout<T>(
  p: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (!timeoutMs && !signal) return p;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      fn();
    };
    const timer =
      timeoutMs > 0
        ? setTimeout(() => finish(() => reject(new Error(`timeout after ${timeoutMs}ms`))), timeoutMs)
        : null;
    const onAbort = () => finish(() => reject(new Error('aborted')));
    if (signal) {
      if (signal.aborted) return finish(() => reject(new Error('aborted')));
      signal.addEventListener('abort', onAbort, { once: true });
    }
    p.then(
      (v) =>
        finish(() => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(v);
        }),
      (e) =>
        finish(() => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        }),
    );
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
