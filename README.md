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

## Architecture

- **MCP client** — connects to deployed (or local) geas-server's MCP endpoint.
- **LLM provider layer** — pluggable; first integration TBD between Anthropic (cached Haiku 4.5) and Google (Gemini Flash 2.5). See [#585](https://github.com/tinycamera/geas-server/issues/585).
- **Conversation state** — Firestore (consistent with geas-server).
- **Identity** — agent acts under the user's UID; harness stores user OAuth refresh tokens server-side.

Backlog: <https://github.com/tinycamera/geas-server/issues?q=label%3Ageas-agent>
