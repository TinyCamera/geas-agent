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
npm install
GEAS_MCP_URL=http://localhost:8088/mcp GEAS_DEV_UID=agent-dev npm run scenario:goblin-hunt
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
| 0 | Completed (including benign early returns) — **green** |
| 1 | Scenario threw, or unknown scenario name |
| 2 | Environment / connection failure (couldn't reach server, auth) |
| 3 | Bad invocation (missing scenario name argument) |

## 4. Troubleshooting

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

## 5. Acceptance (geas-server#583)

This runbook passes if a clean checkout (no prior knowledge) can follow
steps 1–3 and observe `npm run scenario:goblin-hunt` exit `0`. The
fresh-checkout verification is a human task — Niall runs it.
