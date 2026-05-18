# geas-agent

Agent harness for the Geas multiplayer RPG. A Node/TypeScript service that hosts an LLM-driven agent which plays a character via the [geas-server](https://github.com/tinycamera/geas-server) MCP interface.

This is the **Channel A** half of the user-facing product loop: users chat with their agent here; the agent calls MCP tools against geas-server to act in the world.

## Status

Scaffold only. LLM provider integration, agent loop, conversation persistence, and OAuth identity are tracked in the [geas-server backlog](https://github.com/tinycamera/geas-server/issues?q=label%3Ageas-agent).

## Local hello-world

```bash
nvm use   # Node 22
npm install
npm test
npm run build
npm run dev
```

## Local dev runbook

geas-agent drives a character through geas-server's MCP endpoint, so running
it locally means standing up the geas-server stack too. The full
fresh-checkout path — prerequisites, starting the geas-server stack with the
dev auth bypass, env vars, and getting `npm run scenario:goblin-hunt` to exit
green — is in **[docs/dev.md](docs/dev.md)**.

Quickest path once the geas-server stack is up on `:8088`:

```bash
GEAS_MCP_URL=http://localhost:8088/mcp GEAS_DEV_UID=agent-dev npm run scenario:goblin-hunt
```

## Architecture

- **MCP client** — connects to deployed (or local) geas-server's MCP endpoint.
- **LLM provider layer** — pluggable; first integration TBD between Anthropic (cached Haiku 4.5) and Google (Gemini Flash 2.5). See [#585](https://github.com/tinycamera/geas-server/issues/585).
- **Prompt cache layout** — caching is the dominant cost lever (the naïve protocol misses Niall's <$0.05/active-hr gate). `buildCachedRequest()` in `src/llm/cache.ts` owns breakpoint placement: tool defs, system persona, and a stable game-state prefix are cached; the per-turn churn is not. Full layout + invalidation rules: [docs/cache-layout.md](docs/cache-layout.md).
- **Conversation state** — Firestore (consistent with geas-server).
- **Identity** — agent acts under the user's UID; harness stores user OAuth refresh tokens server-side.

Backlog: <https://github.com/tinycamera/geas-server/issues?q=label%3Ageas-agent>
