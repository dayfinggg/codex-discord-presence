# ChatGPT Discord Presence

[![npm version](https://img.shields.io/npm/v/codex-discord-presence?logo=npm)](https://www.npmjs.com/package/codex-discord-presence)
[![CI](https://github.com/dayfinggg/codex-discord-presence/actions/workflows/ci.yml/badge.svg)](https://github.com/dayfinggg/codex-discord-presence/actions/workflows/ci.yml)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22.18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

ChatGPT-themed Discord Rich Presence for OpenAI Codex Desktop and Codex CLI. Show the active model,
reasoning effort, plan limits, reset countdowns, token usage, cost, context, goals, Fast mode, agents,
and secure remote SSH sessions on Windows, macOS, and Linux.

![ChatGPT icon for the dark theme](assets/chatgpt-liquid-dark.png)

## Quick start

You only need Node.js 22.18 or newer and Discord Desktop. No Discord application or `.env` file is
required: the package includes a ready-to-use public Rich Presence application and asset keys.

```bash
npx codex-discord-presence
```

For a persistent command:

```bash
npm install --global codex-discord-presence
codex-presence
```

The service discovers `CODEX_HOME` for the current user and supports both ordinary Codex chats and
project-backed tasks. Stop a foreground instance with `Ctrl+C`.

## What it shows

| Discord field | Live data |
| --- | --- |
| Details | Plan, available resets, 5-hour and 7-day allowance left, reset countdowns |
| State | Model, reasoning effort, Fast mode, current action, Goal, Plan mode, Realtime, agents |
| Timer | Current Codex session duration |
| Large-image tooltip | Input, cached input, output, cost, and context usage |
| Small-image tooltip | Day, week, month, and all-time token and cost totals |

Fields are omitted when their source is unavailable and are shortened to Discord's limits without
discarding the most useful information.

## Desktop, CLI, and platforms

| Platform | Codex Desktop | Codex CLI | Per-user autostart |
| --- | ---: | ---: | ---: |
| Windows | Yes | Yes | Registry launcher with a bounded supervisor log |
| macOS | Yes, where available | Yes | LaunchAgent |
| Linux | Where available | Yes | systemd user service |

On Windows the scanner distinguishes the real Codex Desktop window and Codex CLI from helper
`app-server` processes. On macOS and Linux it handles native `ps` elapsed-time formats and detects
both `codex` and the Codex Desktop executable.

On Windows, presence follows the task selected in Codex Desktop or the Codex CLI session in the
foreground. Background tasks, goals, and remote sessions cannot replace the selected task.

## Autostart

```bash
codex-presence autostart
```

Remove it with:

```bash
codex-presence autostart:remove
```

`Ctrl+C` stops only the foreground instance in the current terminal. The removal command also
gracefully stops an active background instance so Discord activity is cleared before exit.

The service writes its own warnings and errors to a rotating, size-bounded per-user log. Background
stdout and stderr are disabled on macOS and Linux to avoid duplicate, unbounded system logs.

## Optional configuration

Defaults work without configuration. Pass options directly:

```bash
codex-presence --log-level debug --plan-name Pro
codex-presence --codex-home ~/.custom-codex
```

Or copy `.env.example`, edit it, and run `codex-presence --env /path/to/.env`.

| CLI option | Environment variable | Purpose |
| --- | --- | --- |
| `--application-id` | `CODEX_DISCORD_APPLICATION_ID` | Use a different Discord application |
| `--codex-home` | `CODEX_HOME` | Override the Codex data directory |
| `--remote-hosts` | `CODEX_REMOTE_HOSTS` | Comma-separated SSH aliases, or `off` |
| `--plan-name` | `CODEX_PLAN_NAME` | Override the detected plan label |
| `--log-level` | `RPC_LOG_LEVEL` | `debug`, `info`, `warn`, `error`, or `silent` |
| `--log-max-bytes` | `RPC_LOG_MAX_BYTES` | Maximum size of the active log; default 1 MiB |

The repository `.env` is ignored and never published to GitHub or npm.

## Secure remote Codex sessions

Remote hosts are discovered from Codex's own managed-remote state by default. To use an explicit
allowlist, configure SSH aliases instead of addresses or shell fragments:

```bash
codex-presence --remote-hosts work-box,dev-box
```

Only strict SSH alias names are accepted. Values beginning with `-`, user/address forms, whitespace,
and shell syntax are rejected. SSH runs with `shell: false`, batch mode, connection timeouts, bounded
reconnect backoff, and no hardcoded hostname, user, port, or key.

## Logging and privacy

The default level is `warn`, so normal polling, hooks, snapshots, and Discord updates are not logged.
The active log and one archive are each limited to 1 MiB by default. The service reads local Codex
state, talks to the local Discord IPC endpoint, and only opens SSH for discovered or explicitly
allowed aliases.

## Build from source

```bash
git clone https://github.com/dayfinggg/codex-discord-presence.git
cd codex-discord-presence
npm ci
npm test
npm run typecheck
npm run build
npm start
```

## Discord assets

Ready-to-upload images are in [`assets/`](assets). The default application uses these keys:

| Key | File |
| --- | --- |
| `chatgpt-liquid-light` | `assets/chatgpt-liquid-light.png` |
| `chatgpt-liquid-light` | `assets/chatgpt-liquid-light.png` |
| `chatgpt-liquid-dark` | `assets/chatgpt-liquid-dark.png` |
| `chatgpt-stats-light` | `assets/chatgpt-stats-light.png` |
| `chatgpt-stats-dark` | `assets/chatgpt-stats-dark.png` |
| `usage-stats` | `assets/usage-stats.png` |

## License and attribution

[MIT](LICENSE). This community project is not affiliated with or endorsed by OpenAI or Discord.
OpenAI, Codex, and Discord are trademarks of their respective owners.
