# Codex Discord Presence

## Overview

This repository contains a standalone Node.js service that reads local Codex Desktop and Codex CLI
state and publishes it through Discord Rich Presence. Node.js 22.18 or newer and npm are required.

The entry point is `src/index.ts`. It creates the state watchers, builds the active Codex snapshot,
updates Discord RPC, and handles shutdown.

## Code map

- `src/config.ts` resolves environment settings and portable user-data paths.
- `src/codex/codex-store.ts` owns session selection and the current presence snapshot.
- `src/codex/rollout-watcher.ts` tails local Codex rollout files.
- `src/codex/remote-watcher.ts` discovers and tails configured SSH remotes without a shell.
- `src/codex/rollout-parser.ts` converts rollout records into typed events.
- `src/codex/desktop-selection.ts` follows the project selected in Codex Desktop.
- `src/codex/goal-watcher.ts` reads per-thread Goal state.
- `src/codex/service-tier-watcher.ts` reads model, effort, and service-tier settings.
- `src/codex/reset-credits-watcher.ts` reads available reset credits.
- `src/codex/presence.ts` and `src/discord/presence-builder.ts` format Discord fields.
- `src/discord/rpc-client.ts` manages the local Discord RPC connection.
- `src/util/` contains logging and process-liveness support.
- `tests/` contains the automated test suite.

Runtime configuration is read from `.env`. Generated JavaScript is written to `dist/`; runtime logs
and caches are written to the operating system's user-data directory resolved by `src/config.ts`.

## Commands

- `npm install` — install dependencies.
- `npm start` — build and start the service.
- `npm run dev` — start the TypeScript entry point in watch mode.
- `npm test` — run the test suite.
- `npm run typecheck` — run TypeScript checking without emitting files.
- `npm run build` — compile `src/` into `dist/`.
- `npm run autostart` — build and register per-user startup on Windows, macOS, or Linux.
- `npm run autostart:remove` — remove per-user startup registration.
- `npm pack` — build and create the publishable npm archive.

Run `npm test`, `npm run typecheck`, `npm run build`, and `npm pack --dry-run` after source,
configuration, installer, or packaging changes.
Do not edit generated files in `dist/` or dependencies in `node_modules/`.
