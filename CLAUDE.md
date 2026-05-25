# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

`geas-agent` is a Node/TypeScript service that hosts an LLM-driven agent. The agent connects to the [geas-server](https://github.com/tinycamera/geas-server) MCP endpoint and acts on a character on behalf of a human user.

This repo is a **sibling** of `geas-server`. Shared conventions live in `geas-server/CLAUDE.md` — read that for monorepo layout, branch flow (develop → main via release PR), test discipline, and other Geas-project standards.

## Status

MCP client wrapper (#579) shipped 2026-05-16 — `GeasMcpClient` is the canonical entry point for talking to geas-server's MCP endpoint. Real LLM-driven agent loop (provider, identity, deploy) lives in epics #584/#586/#587/#588/#589/#590 on the geas-server backlog.

## Architecture

- `src/mcp/client.ts` — `GeasMcpClient`, the thin wrapper over `@modelcontextprotocol/sdk`'s `Client`. Reconnect-on-drop with capped exponential backoff; returns `Result<T>` instead of throwing.
- `src/mcp/tools.ts` — hand-written `GEAS_TOOL_NAMES` list + arg shapes. Drift detected at connect time via `listTools()` (missing tool → error, extra → warning).
- `src/mcp/validator.ts` — pre-dispatch JSON-schema validator (#658). Caches `inputSchema` from `listTools()` on connect and rejects typos / missing required args / wrong-type args locally before the network round-trip. Extras warn (not fail) so schema drift doesn't block legitimate calls.
- `src/mcp/errors.ts` — `GeasMcpError` discriminated union: `not_connected | transport | unauthorized | tool_error | invalid_response | timeout | aborted | unknown_tool | missing_required | wrong_type`.
- `tests/integration/` — live-server tests, opt-in via `npm run test:integration` with `GEAS_LIVE_MCP_URL` + `GEAS_LIVE_DEV_UID` env set.

## Commands

```bash
npm install            # install deps
npm test               # vitest run (unit tests under src/)
npm run test:watch
npm run test:integration  # opt-in; needs GEAS_LIVE_MCP_URL + GEAS_LIVE_DEV_UID
npm run build          # tsc to dist/
npm run dev            # tsx watch on src/index.ts
npm run lint           # tsc --noEmit
```

## Conventions

- TypeScript strict; ES2022 module target.
- Vitest for tests.
- Node 22 (`.nvmrc`).
- Branch flow: `develop` is default and integration trunk; `main` is production. CI runs on both.
