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
- `src/persistence/conversation-store.ts` — `ConversationStore` interface + `PersistedTurn` shape + `InMemoryConversationStore`. Append-only per-turn log keyed by `(uid, characterId)`.
- `src/persistence/firestore-conversation-store.ts` — Firestore impl writing under `agent_conversations/{uid}/characters/{characterId}/turns/{turnDocId}`. Doc id is zero-padded turn index for cheap ordering; reads use `orderBy('turnIndex', ...)` (emulator rejects descending `__name__` scans).
- `src/persistence/firestore.ts` — agent-side Firestore singleton init mirroring `packages/mcp-server/src/firestore.ts` (emulator / SA / ADC env triad).
- `src/loop/run-with-retry.ts` — composed validation+retry contract (#662). Wires `[validator → MCP dispatch → stuck detector → recovery prompt → retry budget]` into one `runWithRetry()` call the future agent loop drives once per tool intent. The recovery driver (LLM-backed or scripted) decides each retry; the helper owns the policy.
- `src/server/` — Channel-A user-facing API (#667). `wire.ts` is the protocol-versioned event/request union (REPL #648, web client #592 consume this). `auth.ts` is the bearer-token verifier (`StaticDevVerifier` for tests, `FirebaseTokenVerifier` for prod). `event-buffer.ts` + `hub.ts` are the per-`(uid,characterId)` ring buffer + pub/sub fan-out (256-event resume window). `session-registry.ts` lazily mints an `IdleSession` per `(uid, characterId)`. `server.ts` exposes `POST /chat`, `POST /resolve-decision`, `GET /healthz`, `WS /events` (hello + ping + typed events; reconnect via `?lastEventId=`). Closes epic #587.
- `tests/integration/` — live-server tests, opt-in via `npm run test:integration` with `GEAS_LIVE_MCP_URL` + `GEAS_LIVE_DEV_UID` env set. Retry-layer contract tests live in `retry-layer.live.test.ts` and run via `npm run test:retry` (one file per failure mode; one real-LLM leg gated on `ANTHROPIC_API_KEY`).
- `src/verify/` — verification harness (#673, parent epic #589). Boots the real agent loop and drives it through scripted `VerifyScenario`s (natural-language user turns → LLM → tool dispatch → server mutation), then asserts on resulting server state and reports tokens/cost/retries. Entry: `npm run test:verify`. **Default mode** is deterministic + keyless: an in-memory stateful fake geas-server (`fake-world.ts`) driven by `NoopProvider` replaying each scenario's `noopScript`. **Live mode** (`GEAS_LIVE_MCP_URL` set) targets a real geas-server (`live-world.ts`) with a real provider — the "real LLM + real server" acceptance leg. `runner.ts` is the driver; `scenarios/` holds scenario files (`smoke` self-test from #673; the standard set — `combat`, `levelup`, `nav`, `recovery`, `stuck` — shipped with #674, each runnable keyless via its `noopScript` and guarded in the default `npm test` gate by `src/verify/scenarios.test.ts`). Forensic event streams write to `verify/runs/<ts>/<scenario>.jsonl` (gitignored). The harness is guarded in the default `npm test` gate by `src/verify/runner.test.ts`. **Cost-regression gate (#675):** after the scenarios run, `cli.ts` checks each one's `totalCostUsd` against the git-tracked baseline `verify/cost-baseline.json` and exits non-zero if any scenario exceeds `baseline × (1 + tolerance)` (default 25%, per-scenario override via the entry's `tolerance`). `src/verify/cost-baseline.ts` owns the file shape + load/save/rebase; `src/verify/cost-regression.ts` is the pure comparison (`checkCostRegression` / `formatCostRegression`), unit-guarded keyless by `src/verify/cost-regression.test.ts`. Keyless ($0) runs never regress against a real (>0) baseline — they read as improvements — so the gate is safe in both the keyless CI leg and the live acceptance leg. Seed/bump the baseline from a **live** run with `npm run verify:rebase-baseline` (a keyless run records $0 and warns); intentional bumps land as a reviewable diff to the JSON.

## Commands

```bash
npm install            # install deps
npm test               # vitest run (unit tests under src/)
npm run test:watch
npm run test:integration  # opt-in; needs GEAS_LIVE_MCP_URL + GEAS_LIVE_DEV_UID
npm run test:verify    # verification harness; default fake+noop (keyless), live via GEAS_LIVE_MCP_URL
npm run build          # tsc to dist/
npm run dev            # tsx watch on src/index.ts
npm run lint           # tsc --noEmit
```

## Conventions

- TypeScript strict; ES2022 module target.
- Vitest for tests.
- Node 22 (`.nvmrc`).
- Branch flow: `develop` is default and integration trunk; `main` is production. CI runs on both.
