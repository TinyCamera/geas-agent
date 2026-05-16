/**
 * Hand-written type surface for the geas-server MCP tools.
 *
 * **Why hand-written and not autogen?** The canonical schemas live in
 * `geas-server/packages/mcp-server/src/tools.ts` as Zod schemas wrapped behind
 * an `any`-typed `registerTool` (the server itself disables generic inference
 * there because TS chokes on 20+ tools). To autogen we'd need to either parse
 * the Zod AST (brittle, breaks every time a tool changes), spin up the server
 * and call `listTools()` at build time (heavyweight, requires Firestore env),
 * or share a third package between repos (premature — the repos diverged on
 * purpose).
 *
 * Instead we hand-write the names + minimal arg shapes, keep tool responses as
 * loose `Record<string, unknown>` (the server payloads are huge and evolve
 * frequently — strong typing them here would lock us behind drift), and
 * defend against drift at runtime with `assertToolSurface()` (see
 * `client.ts`), which calls `client.listTools()` on connect and verifies
 * every name we declare is present. New server tools surface as warnings,
 * removed ones surface as errors.
 *
 * Adding a new tool: add the name to `GEAS_TOOL_NAMES`, add a typed method on
 * `GeasMcpClient` if you want first-class ergonomics, and that's it. The arg
 * shapes here are intentionally permissive `Record<string, unknown>` for
 * tools we don't call directly yet.
 */

export const GEAS_TOOL_NAMES = [
  // Observation
  'look',
  'map',
  'status',
  'build',
  'skills',
  'quests',
  'recipes',
  // Entity queries
  'entities',
  'nearest',
  // Action
  'act',
  // Leveling
  'allocate_stats',
  'choose_levelup',
  // Economy
  'buy_item',
  'sell_item',
  // Social
  'chat',
  'leaderboard',
  // Identity / lifecycle
  'whoami',
  'list_characters',
  'create_character',
  'switch_character',
  'forget_character',
  'reconnect',
  'disconnect',
  // Soul (per-character memory journal)
  'read_soul',
  'update_soul',
  // Misc
  'respawn',
  'ui_ping',
] as const;

export type GeasToolName = (typeof GEAS_TOOL_NAMES)[number];

// ---------------------------------------------------------------------------
// Argument shapes — only the tools we expose as first-class typed methods on
// the wrapper. Everything else goes through `callTool(name, args)` which is
// typed `Record<string, unknown>`.
// ---------------------------------------------------------------------------

export interface LookArgs {
  /* `look` takes no args. */
}

export interface StatusArgs {
  /* none */
}

/**
 * `act` is the canonical mutation surface — moves, attacks, interactions, etc.
 * The server validates via Zod; we keep the wrapper-facing type permissive so
 * agents can pass arbitrary intent payloads without a wrapper bump every time
 * a new intent ships.
 */
export interface ActArgs {
  intent: string;
  [key: string]: unknown;
}

export interface NearestArgs {
  type?: string;
  excludeBoss?: boolean;
  aliveOnly?: boolean;
  maxDist?: number;
}

export interface EntitiesArgs {
  type?: string;
  maxDist?: number;
  excludeBoss?: boolean;
  aliveOnly?: boolean;
  minLevel?: number;
  maxLevel?: number;
}

export interface AllocateStatsArgs {
  str?: number;
  agi?: number;
  int?: number;
  cha?: number;
}

export interface ChooseLevelupArgs {
  pickId: string;
}

export interface BuyItemArgs {
  npcId: string;
  itemType: string;
  qty?: number;
}

export interface SellItemArgs {
  npcId: string;
  itemType: string;
  qty?: number;
}

export interface ChatArgs {
  text: string;
  channel?: string;
}

export interface CreateCharacterArgs {
  name: string;
}

export interface SwitchCharacterArgs {
  playerId: string;
}

/**
 * The wrapper does not try to type tool *responses*. Server payloads are huge,
 * evolve frequently, and the MCP envelope itself is `{ content: [...], structuredContent?: ... }`.
 * Callers extract the bits they want — usually `structuredContent` for typed
 * data or the first text content for human-readable summaries.
 */
export type GeasToolResponse = {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [k: string]: unknown;
};
