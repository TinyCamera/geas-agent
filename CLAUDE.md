# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

`geas-agent` is a Node/TypeScript service that hosts an LLM-driven agent. The agent connects to the [geas-server](https://github.com/tinycamera/geas-server) MCP endpoint and acts on a character on behalf of a human user.

This repo is a **sibling** of `geas-server`. Shared conventions live in `geas-server/CLAUDE.md` — read that for monorepo layout, branch flow (develop → main via release PR), test discipline, and other Geas-project standards.

## Status

Scaffold only as of 2026-05-14. Real work (LLM provider, agent loop, identity, deploy) lives in epics #584/#586/#587/#588/#589/#590 on the geas-server backlog.

## Commands

```bash
npm install       # install deps
npm test          # vitest run (all tests)
npm run test:watch
npm run build     # tsc to dist/
npm run dev       # tsx watch on src/index.ts
npm run lint      # tsc --noEmit
```

## Conventions

- TypeScript strict; ES2022 module target.
- Vitest for tests.
- Node 22 (`.nvmrc`).
- Branch flow: `develop` is default and integration trunk; `main` is production. CI runs on both.
