# geas-agent — local dev runbook

Goal: a fresh checkout reaches **`npm run scenario:goblin-hunt` exiting green** using only
this document. (Tracks geas-server#583.)

geas-agent does not run alone. It drives a character through geas-server's MCP
endpoint, so you run **two repos** locally:

```
geas-agent  ──MCP/HTTP──▶  geas-server mcp-server (:8088)  ──HTTP──▶  geas-server game (:2567)  ──▶  Firestore emulator (:8085)
```

## 1. Prerequisites

- **Node 22+** (`node -v`; the repo pins via `nvm use` → Node 22).
- **npm** (ships with Node).
- **Java 11+** and the **Firebase CLI** (`npm i -g firebase-tools`) — the local
  stack runs the Firestore emulator.
- Both repos checked out as siblings:
  `~/work/geas/geas-server` and `~/work/geas/geas-agent`.

## 2. Start the geas-server local stack

> **Kill any pre-existing stack first.** If you already have a `npm run dev`
> running, it likely does NOT have the dev auth bypass envs set, and the
> scenario will hit 401. Tear it down before starting fresh:
>
> ```bash
> lsof -ti:8088,:2567,:8085 | xargs kill
> ```

`npm run dev` in **geas-server** brings up everything (shared watcher, Firestore
emulator, game server on `:2567`, MCP server on `:8088`) under one command. The
scenario runner can't do an interactive OAuth consent, so start it with the
**dev auth bypass** exported:

```bash
cd ~/work/geas/geas-server
npm install
GEAS_DEV_UNAUTH=1 GEAS_DEV_UID=agent-dev npm run dev
```

- `GEAS_DEV_UNAUTH=1` + `GEAS_DEV_UID` together tell the MCP server to treat
  every `/mcp` request as authenticated as that UID — no bearer needed. Both
  must be set or the bypass stays off (see geas-server `docs/oauth-setup.md`
  → "Local-only bypass"). Never set `GEAS_DEV_UNAUTH` in a deployed env.
- Wait for the MCP line: `[geas-mcp]` listening on `:8088`. The MCP watcher
  has a built-in 3 s head start so the game server binds `:2567` first.

Leave this running in its own terminal.

## 3. Run the scenario from geas-agent

In a second terminal:

```bash
cd ~/work/geas/geas-agent
npm ci
```

> **Install deps first** — even if `node_modules` already exists, recent
> dependency additions may not be in your local install. `npm ci` is stricter
> than `npm install`: it fails loud if `package-lock.json` and `node_modules`
> have drifted, so you can't silently run against stale deps. (Symptom of
> skipping this step: `ERR_MODULE_NOT_FOUND` on `@modelcontextprotocol/sdk` or
> another dep — see §4.)

> **Both env vars must be set in the same shell.** Running just
> `npm run scenario:goblin-hunt` without `GEAS_MCP_URL` exported will fail with
> `GEAS_MCP_URL is required`. Use persistent `export`s in the same terminal as
> the scenario command:

```bash
export GEAS_MCP_URL=http://localhost:8088/mcp
export GEAS_DEV_UID=agent-dev
npm run scenario:goblin-hunt
```

Environment the scenario CLI reads (see `src/scenarios/cli.ts`):

| Var | Required | Meaning |
|-----|----------|---------|
| `GEAS_MCP_URL` | **yes** | MCP endpoint, e.g. `http://localhost:8088/mcp` |
| `GEAS_DEV_UID` | informational | Mirror the server's `GEAS_DEV_UID` so soul/character namespacing lines up |
| `GEAS_BEARER_TOKEN` | prod only | Ignored when the server runs with `GEAS_DEV_UNAUTH=1` |
| `GEAS_SCENARIO_CHAR` | no | Character name to create when no active character exists (default `scenario-<name>`) |
| `GEAS_SCENARIO_TIMEOUT` | no | Wall-clock budget in seconds (default 120) |

**Character seeding is automatic** — the CLI creates a fresh character if the
soul is empty, so no manual seed step is needed. Override the name with
`GEAS_SCENARIO_CHAR` if you want a deterministic one.

### Expected outcome

Exit code **0** = scenario ran to completion. Other codes (from
`src/scenarios/cli.ts`):

| Code | Meaning |
|------|---------|
| 0 | Completed — **green** (combat engaged + resolved) |
| 1 | Scenario threw, or unknown scenario name |
| 2 | Environment / connection failure (couldn't reach server, auth) |
| 3 | Bad invocation (missing scenario name argument) |

**What "green" looks like (#632).** The scenario character spawns at
Bramble Hollow village center (Heartlands — no hostile spawns). Fog of
war (Chebyshev radius 6) hides the closest goblin band (Wilds, ~150
tiles north), so the scenario's first `entities(ENEMY)` call returns
empty. The scenario then teleports to (544, 460) via the dev-only
`set_position` MCP tool (registered only when geas-server is running
with `GEAS_DEV_UNAUTH=1`), waits ~600ms for chunk activation, re-asks,
finds a goblin, and engages combat. A green run logs roughly:

```
[scenario:goblin-hunt] spawn snapshot: pos=(544,608) hp=200/200
[scenario:goblin-hunt] no goblin in fog-of-war range from spawn — teleporting to (544,460) (Wilds) via set_position
[scenario:goblin-hunt] target: Goblin (Lv 5) <id> at (...) dist=...
[scenario:goblin-hunt] round 1: hp=200/200 (100%) inCombat=true
[scenario:goblin-hunt] act result: status=ok outcome=hit
[scenario:goblin-hunt] target <id> no longer in live-enemy list — kill assumed
[scenario:goblin-hunt] returning to spawn from (...) -> (544,608)
[scenario:goblin-hunt] completed in <N>ms
```

The pre-#632 behaviour ("no goblin in fog-of-war range; scenario ends
idle (success)") is no longer green — that branch now throws so a
hollow run surfaces as exit `1`, not exit `0`. If you see the scenario
throw with "no goblin in fog-of-war range, and set_position is not
available", the server isn't running with `GEAS_DEV_UNAUTH=1` — restart
step 2 with both bypass vars set.

## 4. Troubleshooting

- **`ERR_MODULE_NOT_FOUND` (`@modelcontextprotocol/sdk` or similar)** —
  `node_modules` is missing or stale. Run `npm ci` (or `npm install`) in
  `geas-agent`. This is required even if `node_modules` already exists —
  recent dep additions may not be in your local install, and the scenario
  imports will fail before any of the runtime checks below can fire.
- **Exit 2 / "couldn't reach server" / connection refused** — the geas-server
  stack isn't up, or `GEAS_MCP_URL` is wrong. Confirm `curl -s
  localhost:8088/health` responds and `:2567` is bound.
- **401 / Unauthorized from MCP** — the server wasn't started with the bypass.
  Restart step 2 with `GEAS_DEV_UNAUTH=1 GEAS_DEV_UID=agent-dev` exported (both
  vars; `GEAS_DEV_UNAUTH` must be literally `1`).
- **"character not found" / soul mismatch** — `GEAS_DEV_UID` differs between
  the server (step 2) and the scenario (step 3). They must match; characters
  and souls are per-UID.
- **Port already in use (`:2567`, `:8088`, `:8085`)** — a previous stack is
  still running. `lsof -ti:2567,:8088,:8085 | xargs kill`, then restart step 2.
- **Firestore emulator won't start** — missing Java or Firebase CLI; install
  per step 1. Emulator data persists in `geas-server/.firestore-data/`.
- **MCP 401 in an unattended run** — do not try to re-auth in a loop; the
  bypass is the only non-interactive path locally. Verify both bypass vars.
- **Scenario throws "no goblin in fog-of-war range, and set_position is not
  available"** (#632) — `set_position` is dev-only and only registered when
  geas-server runs with `GEAS_DEV_UNAUTH=1`. Restart step 2 with both bypass
  vars; the scenario uses this tool to teleport from village-center spawn
  (Heartlands, no goblins) into the Wilds.
- **Scenario throws "no goblin in fog-of-war range after teleport"** (#632) —
  the world layout has drifted from canonical, or the Wilds region is empty.
  Check that `geas-server/packages/shared/src/chunks.ts` `REGION_SPAWN_CONFIGS.WILDS`
  still includes `'goblin'` in `enemyTypes` and `enemiesPerChunk` is > 0.

## 5. Acceptance (geas-server#583)

This runbook passes if a clean checkout (no prior knowledge) can follow
steps 1–3 and observe `npm run scenario:goblin-hunt` exit `0`. The
fresh-checkout verification is a human task — Niall runs it.
