import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

export interface ResetCreditsResult {
  ok: boolean;
  available?: number;
  limits?: Limits;
}

export interface ResetCreditsReader {
  read(): Promise<ResetCreditsResult>;
  close(): void;
}

export type ResetCreditsReaderFactory = (command: CodexCommand) => ResetCreditsReader;

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

class CodexAppServerReader implements ResetCreditsReader {
  private child?: ChildProcessWithoutNullStreams;
  private startPromise?: Promise<boolean>;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (message: Record<string, unknown> | undefined) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly command: CodexCommand) {}

  async read(): Promise<ResetCreditsResult> {
    if (!(await this.ensureStarted())) return { ok: false };
    const message = await this.call("account/rateLimits/read");
    if (!message || message.error !== undefined) return { ok: false };
    const available = resetCreditsFromRateLimitsResponse(message);
    const limits = limitsFromRateLimitsResponse(message);
    return {
      ok: true,
      ...(available === undefined ? {} : { available }),
      ...(limits === undefined ? {} : { limits }),
    };
  }

  close(): void {
    const child = this.child;
    this.child = undefined;
    this.startPromise = undefined;
    this.failPending();
    child?.kill();
  }

  private ensureStarted(): Promise<boolean> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start();
    return this.startPromise;
  }

  private async start(): Promise<boolean> {
    const child = spawn(this.command.executable, this.command.args, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stderr.resume();
    child.once("error", () => this.handleExit(child));
    child.once("exit", () => this.handleExit(child));
    child.stdin.on("error", () => this.handleExit(child));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      while (true) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line === "") continue;
        try {
          const message = object(JSON.parse(line));
          const id = message?.id;
          if (typeof id !== "number") continue;
          const pending = this.pending.get(id);
          if (!pending) continue;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.resolve(message);
        } catch {}
      }
    });

    const spawned = await new Promise<boolean>((resolve) => {
      child.once("spawn", () => resolve(true));
      child.once("error", () => resolve(false));
    });
    if (!spawned || this.child !== child) return false;
    const initialized = await this.call("initialize", {
      clientInfo: {
        name: "codex-discord-presence",
        title: "Codex Discord Presence",
        version: "1.0.0",
      },
    });
    if (!initialized || initialized.error !== undefined || this.child !== child) {
      this.close();
      return false;
    }
    try {
      child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
      return true;
    } catch {
      this.close();
      return false;
    }
  }

  private call(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    const child = this.child;
    if (!child) return Promise.resolve(undefined);
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(undefined);
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      try {
        child.stdin.write(JSON.stringify({ method, id, ...(params ? { params } : {}) }) + "\n");
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(undefined);
      }
    });
  }

  private handleExit(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.startPromise = undefined;
    this.failPending();
  }

  private failPending(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(undefined);
    }
    this.pending.clear();
    this.buffer = "";
  }
}

const createResetCreditsReader: ResetCreditsReaderFactory = (command) =>
  new CodexAppServerReader(command);

export class CodexResetCreditsWatcher {
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private polling = false;
  private initialized = false;
  private lastAvailable?: number;
  private lastLimitsKey?: string;
  private lastCommand?: CodexCommand;
  private reader?: ResetCreditsReader;

  constructor(
    private readonly onUpdate: (available: number | undefined, limits: Limits | undefined) => void,
    private readonly intervalMs = DEFAULT_POLL_MS,
    private readonly readerFactory: ResetCreditsReaderFactory = createResetCreditsReader,
    private readonly commands: () => CodexCommand[] = codexAppServerCommands,
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
    this.reader?.close();
    this.reader = undefined;
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      if (this.lastCommand && this.reader && (await this.tryReader(this.reader))) return;
      if (this.stopped) return;
      this.reader?.close();
      this.reader = undefined;
      this.lastCommand = undefined;
      for (const command of this.commands()) {
        if (this.stopped) return;
        const reader = this.readerFactory(command);
        this.reader = reader;
        if (await this.tryReader(reader)) {
          this.lastCommand = command;
          return;
        }
        if (this.reader === reader) {
          reader.close();
          this.reader = undefined;
        }
      }
      log.debug("Codex app-server rate-limit read failed");
    } finally {
      this.polling = false;
    }
  }

  private async tryReader(reader: ResetCreditsReader): Promise<boolean> {
    const result = await reader.read();
    if (this.stopped || !result.ok) return false;
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
