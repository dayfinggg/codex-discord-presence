import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, extname, join } from "node:path";
import type { Limits, LimitWindow } from "../types.ts";
import { createLogger } from "../util/logger.ts";

const log = createLogger("codex-reset-credits");
const DEFAULT_POLL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const WINDOW_TOLERANCE_MINUTES = 5;

interface CodexCommand {
  executable: string;
  args: string[];
}

interface ResetCreditsResult {
  ok: boolean;
  available?: number;
  limits?: Limits;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function availableCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

export function resetCreditsFromRateLimitsResponse(value: unknown): number | undefined {
  const response = object(value);
  const result = object(response?.result) ?? response;
  const credits = object(result?.rateLimitResetCredits) ?? object(result?.rate_limit_reset_credits);
  if (!credits) return undefined;
  return availableCount(credits.availableCount) ?? availableCount(credits.available_count);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rateLimitWindow(value: unknown): { durationMinutes: number; window: LimitWindow } | undefined {
  const entry = object(value);
  if (!entry) return undefined;
  const used = finiteNumber(entry.usedPercent) ?? finiteNumber(entry.used_percent);
  const durationMinutes =
    finiteNumber(entry.windowDurationMins) ??
    finiteNumber(entry.window_duration_mins) ??
    finiteNumber(entry.windowMinutes) ??
    finiteNumber(entry.window_minutes);
  if (used === undefined || durationMinutes === undefined) return undefined;
  const resetsAtSeconds = finiteNumber(entry.resetsAt) ?? finiteNumber(entry.resets_at);
  return {
    durationMinutes,
    window: {
      usedPercentage: Math.max(0, Math.min(100, used)),
      ...(resetsAtSeconds === undefined ? {} : { resetsAt: resetsAtSeconds * 1_000 }),
    },
  };
}

export function limitsFromRateLimitsResponse(value: unknown, at = Date.now()): Limits | undefined {
  const response = object(value);
  const result = object(response?.result) ?? response;
  const direct = object(result?.rateLimits) ?? object(result?.rate_limits);
  const directId = direct?.limitId ?? direct?.limit_id;
  const byId = object(result?.rateLimitsByLimitId) ?? object(result?.rate_limits_by_limit_id);
  const canonical = object(byId?.codex);
  const rateLimits =
    direct && (directId === undefined || directId === "codex") ? direct : canonical ?? direct;
  if (!rateLimits) return undefined;

  const limits: Limits = { updatedAt: at };
  for (const value of [rateLimits.primary, rateLimits.secondary]) {
    const parsed = rateLimitWindow(value);
    if (
      parsed &&
      Math.abs(parsed.durationMinutes - 300) <= WINDOW_TOLERANCE_MINUTES
    ) limits.fiveHour = parsed.window;
    if (
      parsed &&
      Math.abs(parsed.durationMinutes - 10_080) <= WINDOW_TOLERANCE_MINUTES
    ) limits.sevenDay = parsed.window;
  }
  return limits.fiveHour || limits.sevenDay ? limits : undefined;
}

function nativeCodexExecutables(root: string, depth = 0): string[] {
  if (depth > 7 || !existsSync(root)) return [];
  const found: string[] = [];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === "codex.exe") found.push(path);
      else if (entry.isDirectory()) found.push(...nativeCodexExecutables(path, depth + 1));
    }
  } catch {}
  return found;
}

function directCommand(executable: string): CodexCommand {
  if (process.platform === "win32" && extname(executable).toLowerCase() === ".cmd") {
    const command = `"${executable.replaceAll('"', '""')}" app-server --listen stdio://`;
    return { executable: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { executable, args: ["app-server", "--listen", "stdio://"] };
}

export function codexAppServerCommands(
  env: Record<string, string | undefined> = process.env,
): CodexCommand[] {
  const candidates: string[] = [];
  const configured = env.CODEX_APP_SERVER_EXECUTABLE?.trim();
  if (configured) candidates.push(configured);

  const pathEntries = (env.PATH ?? env.Path ?? "").split(delimiter).filter((entry) => entry !== "");
  for (const entry of pathEntries) {
    if (process.platform === "win32") {
      const npmPackageRoot = join(entry, "node_modules", "@openai", "codex", "node_modules", "@openai");
      candidates.push(...nativeCodexExecutables(npmPackageRoot));
      for (const name of ["codex.exe", "codex.cmd"]) {
        const path = join(entry, name);
        if (existsSync(path)) candidates.push(path);
      }
    } else {
      const path = join(entry, "codex");
      if (existsSync(path)) candidates.push(path);
    }
  }

  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) {
      const root = join(localAppData, "OpenAI", "Codex", "bin");
      candidates.push(
        ...nativeCodexExecutables(root).sort((a, b) => {
          try {
            return statSync(b).mtimeMs - statSync(a).mtimeMs;
          } catch {
            return 0;
          }
        }),
      );
    }
  }

  const seen = new Set<string>();
  return candidates
    .filter((candidate) => {
      const key = candidate.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(directCommand);
}

function requestResetCredits(command: CodexCommand): Promise<ResetCreditsResult> {
  return new Promise((resolve) => {
    const child = spawn(command.executable, command.args, {
      env: process.env,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let settled = false;
    let buffer = "";
    const finish = (result: ResetCreditsResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false }), REQUEST_TIMEOUT_MS);

    child.once("error", () => finish({ ok: false }));
    child.once("exit", () => finish({ ok: false }));
    child.stdin.on("error", () => finish({ ok: false }));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line === "") continue;
        try {
          const message = object(JSON.parse(line));
          if (message?.id === 1) {
            if (message.error !== undefined) {
              finish({ ok: false });
              continue;
            }
            const messages = [
              { method: "initialized", params: {} },
              { method: "account/rateLimits/read", id: 3 },
            ];
            child.stdin.write(messages.map((item) => JSON.stringify(item)).join("\n") + "\n");
            continue;
          }
          if (message?.id !== 3) continue;
          if (message.error !== undefined) finish({ ok: false });
          else {
            const available = resetCreditsFromRateLimitsResponse(message);
            const limits = limitsFromRateLimitsResponse(message);
            finish({
              ok: true,
              ...(available === undefined ? {} : { available }),
              ...(limits === undefined ? {} : { limits }),
            });
          }
        } catch {}
      }
    });

    child.once("spawn", () => {
      const initialize = {
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "codex-discord-presence",
            title: "Codex Discord Presence",
            version: "1.0.0",
          },
        },
      };
      try {
        child.stdin.write(JSON.stringify(initialize) + "\n");
      } catch {
        finish({ ok: false });
      }
    });
  });
}

export class CodexResetCreditsWatcher {
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private polling = false;
  private initialized = false;
  private lastAvailable?: number;
  private lastLimitsKey?: string;
  private lastCommand?: CodexCommand;

  constructor(
    private readonly onUpdate: (available: number | undefined, limits: Limits | undefined) => void,
    private readonly intervalMs = DEFAULT_POLL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      if (this.lastCommand && (await this.tryCommand(this.lastCommand))) return;
      this.lastCommand = undefined;
      for (const command of codexAppServerCommands()) {
        if (await this.tryCommand(command)) {
          this.lastCommand = command;
          return;
        }
      }
      log.debug("Codex app-server rate-limit read failed");
    } finally {
      this.polling = false;
    }
  }

  private async tryCommand(command: CodexCommand): Promise<boolean> {
    const result = await requestResetCredits(command);
    if (!result.ok) return false;
    const limitsKey = JSON.stringify({
      fiveHour: result.limits?.fiveHour,
      sevenDay: result.limits?.sevenDay,
    });
    if (
      !this.initialized ||
      result.available !== this.lastAvailable ||
      limitsKey !== this.lastLimitsKey
    ) {
      this.initialized = true;
      this.lastAvailable = result.available;
      this.lastLimitsKey = limitsKey;
      log.debug(
        `available=${result.available ?? "none"} 5h=${result.limits?.fiveHour?.usedPercentage ?? "none"} 7d=${result.limits?.sevenDay?.usedPercentage ?? "none"}`,
      );
      this.onUpdate(result.available, result.limits);
    }
    return true;
  }
}
