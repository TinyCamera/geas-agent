/**
 * Local pre-dispatch validation for MCP tool calls (#658, parent #586).
 *
 * Catches the cheap-model failure modes BEFORE we burn a network round-trip
 * + tool-budget tick: misspelled tool names, missing required args, wrong
 * argument types. Schemas come from `client.listTools()` at connect time
 * (the MCP SDK surfaces each tool's `inputSchema` — a JSON-Schema-shaped
 * object with `properties` + `required`).
 *
 * Design notes
 * ------------
 *
 *  - **Structured failure, not exceptions.** Same shape as the rest of the
 *    wrapper: `{ ok: true } | { ok: false, kind, message }`. The agent loop
 *    branches on `kind` and decides retry-vs-bail; that policy lives in
 *    stuck-detector / retry-budget (sibling tickets under #586), NOT here.
 *
 *  - **Conservative on unknown shapes.** If a property declares a `type` we
 *    don't recognize (e.g. `"object"`, `"array"`, an enum/oneOf/anyOf
 *    construct, or no type at all), we DO NOT fail the call. The server's
 *    Zod schema is the source of truth — local validation is a fast-path
 *    typo-guard, not a re-implementation of JSON Schema. False positives
 *    here would block legitimate calls, which is strictly worse than the
 *    round-trip we're trying to avoid.
 *
 *  - **Extras warn, don't fail.** Schemas evolve faster than this wrapper.
 *    A new agent build is occasionally going to ship args the cached schema
 *    hasn't seen yet (or pass the binding envelope `_agentBinding`, see
 *    `client.injectBinding`). Returning the call rather than the wrapper's
 *    blessing-list is the safer bias. Callers can surface the warn list
 *    via the `extras` field; the wrapper logs it via `onWarning`.
 *
 *  - **Unknown-tool detection is opt-in by passing the cached name set.**
 *    When the schema map is empty (validator built but no schemas cached
 *    yet — e.g. before first `connect()`), every call short-circuits to
 *    `ok` so the validator never blocks a session that hasn't had a chance
 *    to populate its surface. This matters for the wrapper's call path:
 *    connect-time `listTools` populates the map, after which validation
 *    actually runs.
 *
 *  - **Reserved keys pass through.** `_agentBinding` is the wrapper's own
 *    envelope (see `client.injectBinding`) and isn't part of any tool's
 *    declared schema. Treat it as a known extra — neither flagged as
 *    unexpected nor required.
 */

/**
 * Minimal JSON-Schema shape we care about. Mirrors the MCP SDK's `Tool`
 * `inputSchema` (which is itself a `z.object({...}).catchall(z.unknown())`).
 */
export interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, JsonSchemaProperty>;
  required?: readonly string[];
  [k: string]: unknown;
}

export interface JsonSchemaProperty {
  type?: JsonSchemaPrimitive | readonly JsonSchemaPrimitive[];
  [k: string]: unknown;
}

export type JsonSchemaPrimitive =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null';

export type ValidationFailureKind =
  | 'unknown_tool'
  | 'missing_required'
  | 'wrong_type';

export type ValidationResult =
  | { ok: true; extras: string[] }
  | {
      ok: false;
      kind: ValidationFailureKind;
      message: string;
      /** For missing_required / wrong_type: the arg name(s). */
      args?: string[];
    };

/** Sentinel name reserved by the client wrapper for the binding envelope. */
const RESERVED_KEYS = new Set<string>(['_agentBinding']);

/**
 * Validate `args` against the cached schema for `toolName`.
 *
 * When `schemas` is empty the validator returns `{ok: true, extras: []}` —
 * we have nothing to compare against, so don't block.
 */
export function validateToolCall(
  toolName: string,
  args: Record<string, unknown>,
  schemas: ReadonlyMap<string, ToolInputSchema>,
): ValidationResult {
  // No surface cached yet — short-circuit (don't block first calls).
  if (schemas.size === 0) return { ok: true, extras: [] };

  const schema = schemas.get(toolName);
  if (!schema) {
    return {
      ok: false,
      kind: 'unknown_tool',
      message: `unknown tool: ${toolName}`,
    };
  }

  const required = schema.required ?? [];
  const properties = schema.properties ?? {};

  // 1. Missing required args.
  const missing = required.filter(
    (k) => !(k in args) || args[k] === undefined,
  );
  if (missing.length > 0) {
    return {
      ok: false,
      kind: 'missing_required',
      message: `tool '${toolName}' missing required arg${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
      args: missing,
    };
  }

  // 2. Wrong types on declared properties.
  for (const [argName, argValue] of Object.entries(args)) {
    if (argValue === undefined) continue;
    if (RESERVED_KEYS.has(argName)) continue;
    const propSchema = properties[argName];
    if (!propSchema) continue; // extras handled below
    const declared = propSchema.type;
    if (!declared) continue; // no type → conservative pass
    const ok = matchesType(argValue, declared);
    if (!ok) {
      return {
        ok: false,
        kind: 'wrong_type',
        message: `tool '${toolName}' arg '${argName}' expected ${formatType(declared)}, got ${actualType(argValue)}`,
        args: [argName],
      };
    }
  }

  // 3. Extras — collect, don't fail. Callers can warn-log.
  const declaredNames = new Set(Object.keys(properties));
  const extras: string[] = [];
  for (const k of Object.keys(args)) {
    if (RESERVED_KEYS.has(k)) continue;
    if (!declaredNames.has(k)) extras.push(k);
  }

  return { ok: true, extras };
}

/**
 * Build the schema cache from the result of `Client.listTools()`. The SDK
 * types `inputSchema` as `{type:'object', properties?, required?}` plus a
 * catchall, so we cast through `unknown` rather than depending on the SDK's
 * internal Zod types.
 */
export function buildSchemaCache(
  tools: ReadonlyArray<{ name: string; inputSchema?: unknown }>,
): Map<string, ToolInputSchema> {
  const map = new Map<string, ToolInputSchema>();
  for (const t of tools) {
    if (!t.inputSchema || typeof t.inputSchema !== 'object') {
      // Tool with no declared schema → register as no-op schema (any args OK).
      map.set(t.name, { type: 'object' });
      continue;
    }
    map.set(t.name, t.inputSchema as ToolInputSchema);
  }
  return map;
}

// ---------------------------------------------------------------------------
// type helpers
// ---------------------------------------------------------------------------

function matchesType(
  value: unknown,
  declared: JsonSchemaPrimitive | readonly JsonSchemaPrimitive[],
): boolean {
  if (Array.isArray(declared)) {
    return declared.some((t) => matchesPrimitive(value, t));
  }
  return matchesPrimitive(value, declared as JsonSchemaPrimitive);
}

function matchesPrimitive(value: unknown, t: JsonSchemaPrimitive): boolean {
  switch (t) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return (
        typeof value === 'object' && value !== null && !Array.isArray(value)
      );
    case 'null':
      return value === null;
    default:
      // Unknown declared type → conservative pass.
      return true;
  }
}

function formatType(
  declared: JsonSchemaPrimitive | readonly JsonSchemaPrimitive[],
): string {
  if (Array.isArray(declared)) return declared.join('|');
  return String(declared as JsonSchemaPrimitive);
}

function actualType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
