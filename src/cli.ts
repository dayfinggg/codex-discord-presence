#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(resolve(projectDir, "package.json"), "utf8")) as {
  version: string;
};
const flagEnvironment: Record<string, string> = {
  "--application-id": "CODEX_DISCORD_APPLICATION_ID",
  "--codex-home": "CODEX_HOME",
  "--remote-hosts": "CODEX_REMOTE_HOSTS",
  "--plan-name": "CODEX_PLAN_NAME",
  "--log-level": "RPC_LOG_LEVEL",
  "--log-max-bytes": "RPC_LOG_MAX_BYTES",
};

function help(): void {
  console.log(`Codex Discord Presence ${packageJson.version}

Usage:
  codex-presence [start] [options]
  codex-presence autostart
  codex-presence autostart:remove

Options:
  --env <file>              Load an optional environment file
  --application-id <id>     Override the shared Discord application
  --codex-home <path>       Override CODEX_HOME
  --remote-hosts <aliases>  Comma-separated SSH aliases, or off
  --plan-name <name>        Override the detected plan label
  --log-level <level>       debug, info, warn, error, or silent
  --log-max-bytes <bytes>   Maximum bytes per log file
  -h, --help                Show help
  -v, --version             Show version`);
}

const args = process.argv.slice(2);
let command = "start";
if (args[0] && !args[0].startsWith("-")) command = args.shift()!;
let envFile: string | undefined;
for (let i = 0; i < args.length; i++) {
  const flag = args[i]!;
  if (flag === "--help" || flag === "-h") { help(); process.exit(0); }
  if (flag === "--version" || flag === "-v") { console.log(packageJson.version); process.exit(0); }
  const value = args[++i];
  if (!value) throw new Error(`${flag} requires a value`);
  if (flag === "--env") envFile = resolve(value);
  else {
    const key = flagEnvironment[flag];
    if (!key) throw new Error(`Unknown option: ${flag}`);
    process.env[key] = value;
  }
}
if (command === "help") { help(); process.exit(0); }
if (command === "version") { console.log(packageJson.version); process.exit(0); }

const candidateEnv = envFile ?? resolve(process.cwd(), ".env");
if (envFile && !existsSync(envFile)) throw new Error(`Environment file not found: ${envFile}`);
if (existsSync(candidateEnv)) process.loadEnvFile(candidateEnv);

if (command === "autostart" || command === "autostart:remove") {
  const script = command === "autostart" ? "install-autostart.mjs" : "remove-autostart.mjs";
  const result = spawnSync(process.execPath, [resolve(projectDir, "scripts", script)], {
    stdio: "inherit",
    windowsHide: true,
    env: process.env,
  });
  process.exit(result.status ?? 1);
}
if (command !== "start") throw new Error(`Unknown command: ${command}`);
await import("./index.js");
