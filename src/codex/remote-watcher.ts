import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GoalState } from "../types.ts";
import type { UsageTotals } from "../types.ts";
import { createLogger } from "../util/logger.ts";
import { parseRollout, sessionIdFromPath } from "./rollout-parser.ts";
import type { CodexEventSink } from "./rollout-watcher.ts";

const log = createLogger("codex-remote");
const SSH_OPTS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=30",
  "-o",
  "ServerAliveCountMax=3",
];
const BACKOFFS_MS = [5_000, 15_000, 60_000];
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCRIPT_PATH = fileURLToPath(new URL("../../scripts/codex-remote-watch.cjs", import.meta.url));
const SSH_ALIAS = /^[a-z0-9](?:[a-z0-9._-]{0,252}[a-z0-9])?$/i;

export type RemoteWatcherMessage =
  | { kind: "rollout"; file: string; line: string }
  | { kind: "thread_metadata"; sessionId: string; title: string; cwd?: string }
  | { kind: "service_tier"; sessionId: string; serviceTier: string | null }
  | { kind: "goals"; states: ReadonlyMap<string, GoalState> }
  | { kind: "monthly_usage"; agent: "claude" | "codex"; usage: RemoteMonthlyUsageRaw };

export interface RemoteMonthlyUsageRaw {
  totalTokens: number;
  usageByModel: Record<string, UsageTotals>;
  day?: RemoteMonthlyUsageRaw;
  week?: RemoteMonthlyUsageRaw;
  allTime?: RemoteMonthlyUsageRaw;
}

export function isSafeRemoteHost(host: string): boolean {
  return SSH_ALIAS.test(host);
}

function parseCompactUsage(value: unknown): RemoteMonthlyUsageRaw | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as { T?: unknown; U?: unknown };
  if (typeof record.T !== "number" || !Number.isFinite(record.T) || record.T < 0) return undefined;
  if (!record.U || typeof record.U !== "object" || Array.isArray(record.U)) return undefined;
  const usageByModel: Record<string, UsageTotals> = {};
  for (const [model, value] of Object.entries(record.U as Record<string, unknown>)) {
    if (model.trim() === "" || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const raw = value as { i?: unknown; o?: unknown; r?: unknown; w?: unknown; h?: unknown };
    const counts = [raw.i, raw.o, raw.r, raw.w];
    if (counts.some((count) => typeof count !== "number" || !Number.isFinite(count) || count < 0)) return undefined;
    if (raw.h !== undefined && (typeof raw.h !== "number" || !Number.isFinite(raw.h) || raw.h < 0)) return undefined;
    usageByModel[model] = {
      input: Math.floor(raw.i as number),
      output: Math.floor(raw.o as number),
      cacheRead: Math.floor(raw.r as number),
      cacheWrite: Math.floor(raw.w as number),
      ...(typeof raw.h === "number" && raw.h > 0 ? { cacheWriteOneHour: Math.floor(raw.h) } : {}),
    };
  }
  return { totalTokens: Math.floor(record.T), usageByModel };
}

export function parseRemoteWatcherMessage(line: string): RemoteWatcherMessage | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  let record: {
    f?: unknown;
    l?: unknown;
    s?: unknown;
    n?: unknown;
    N?: unknown;
    c?: unknown;
    t?: unknown;
    G?: unknown;
    M?: unknown;
    T?: unknown;
    U?: unknown;
    D?: unknown;
    W?: unknown;
    A?: unknown;
  };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    record = parsed as typeof record;
  } catch {
    return undefined;
  }
  if (record.M === "claude" || record.M === "codex") {
    const usage = parseCompactUsage(record);
    if (!usage) return undefined;
    const day = record.D === undefined ? undefined : parseCompactUsage(record.D);
    const week = record.W === undefined ? undefined : parseCompactUsage(record.W);
    const allTime = record.A === undefined ? undefined : parseCompactUsage(record.A);
    if ((record.D !== undefined && !day) || (record.W !== undefined && !week) || (record.A !== undefined && !allTime)) return undefined;
    return {
      kind: "monthly_usage",
      agent: record.M,
      usage: {
        ...usage,
        ...(day ? { day } : {}),
        ...(week ? { week } : {}),
        ...(allTime ? { allTime } : {}),
      },
    };
  }
  if (Array.isArray(record.G)) {
    const states = new Map<string, GoalState>();
    for (const value of record.G) {
      if (!value || typeof value !== "object") return undefined;
      const entry = value as { s?: unknown; e?: unknown; c?: unknown; u?: unknown };
      if (typeof entry.s !== "string" || !SESSION_ID.test(entry.s)) return undefined;
      for (const field of [entry.e, entry.c, entry.u]) {
        if (field !== undefined && (typeof field !== "number" || !Number.isFinite(field) || field < 0)) return undefined;
      }
      states.set(entry.s.toLowerCase(), {
        active: true,
        ...(typeof entry.e === "number" ? { elapsedSeconds: entry.e } : {}),
        ...(typeof entry.c === "number" ? { startedAt: entry.c } : {}),
        ...(typeof entry.u === "number" ? { updatedAt: entry.u } : {}),
      });
    }
    return { kind: "goals", states };
  }
  if (typeof record.s === "string" && SESSION_ID.test(record.s)) {
    const title = typeof record.N === "string" && record.N.trim() !== ""
      ? record.N.trim()
      : typeof record.n === "string" && record.n.trim() !== ""
        ? record.n.trim()
        : undefined;
    if (title) {
      const cwd = typeof record.c === "string" && record.c.trim() !== "" ? record.c.trim() : undefined;
      return {
        kind: "thread_metadata",
        sessionId: record.s.toLowerCase(),
        title,
        ...(cwd ? { cwd } : {}),
      };
    }
    if (record.t === null || typeof record.t === "string") {
      return { kind: "service_tier", sessionId: record.s.toLowerCase(), serviceTier: record.t };
    }
    return undefined;
  }
  if (typeof record.f === "string" && typeof record.l === "string") {
    return { kind: "rollout", file: record.f, line: record.l };
  }
  return undefined;
}

export async function discoverRemoteHosts(codexHome: string): Promise<string[]> {
  try {
    const raw = await readFile(join(codexHome, ".codex-global-state.json"), "utf8");
    const state = JSON.parse(raw) as Record<string, unknown>;
    const hosts = new Set<string>();

    const fromHostId = (hostId: unknown): void => {
      if (typeof hostId === "string") {
        const idx = hostId.lastIndexOf(":");
        const host = idx >= 0 ? hostId.slice(idx + 1) : hostId;
        const candidate = host.trim();
        if (isSafeRemoteHost(candidate)) hosts.add(candidate);
      }
    };

    const projects = state["remote-projects"];
    if (Array.isArray(projects)) {
      for (const project of projects) {
        if (project && typeof project === "object") fromHostId((project as Record<string, unknown>).hostId);
      }
    }

    const managed = state["codex-managed-remote-connections"];
    const consider = (conn: unknown): void => {
      if (!conn || typeof conn !== "object") return;
      const obj = conn as Record<string, unknown>;
      const alias = obj.alias ?? obj.hostname;
      if (typeof alias === "string" && isSafeRemoteHost(alias.trim())) hosts.add(alias.trim());
      else fromHostId(obj.hostId);
    };
    if (Array.isArray(managed)) managed.forEach(consider);
    else if (managed && typeof managed === "object") {
      const obj = managed as Record<string, unknown>;
      if ("alias" in obj || "hostname" in obj || "hostId" in obj) consider(managed);
      else Object.values(obj).forEach(consider);
    }

    return [...hosts];
  } catch (err) {
    log.warn(`remote host discovery failed: ${(err as Error).message}`);
    return [];
  }
}

export class RemoteWatcher {
  private stopped = false;
  private script = "";
  private readonly children = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(
    private readonly hosts: string[],
    private readonly onEvent: CodexEventSink,
    private readonly onServiceTier?: (sessionId: string, serviceTier: string | null) => void,
    private readonly onGoals?: (host: string, states: ReadonlyMap<string, GoalState>) => void,
    private readonly onMonthlyUsage?: (
      host: string,
      agent: "claude" | "codex",
      usage: RemoteMonthlyUsageRaw,
    ) => void,
    private readonly onThreadMetadata?: (sessionId: string, title: string, cwd?: string) => void,
  ) {}

  async start(): Promise<void> {
    if (this.hosts.length === 0) return;
    try {
      this.script = await readFile(SCRIPT_PATH, "utf8");
    } catch (err) {
      log.error(`cannot read remote watch script: ${(err as Error).message}`);
      return;
    }
    for (const host of this.hosts) void this.run(host, 0);
    log.info(`remote watching hosts: ${this.hosts.join(", ")}`);
  }

  stop(): void {
    this.stopped = true;
    for (const child of this.children.values()) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    this.children.clear();
  }

  private async run(host: string, attempt: number): Promise<void> {
    if (this.stopped) return;

    if (!isSafeRemoteHost(host)) {
      log.warn(`ignored unsafe SSH host alias: ${JSON.stringify(host)}`);
      return;
    }

    const child = spawn("ssh", [...SSH_OPTS, host, "node", "--no-warnings", "-"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    this.children.set(host, child);
    try {
      child.stdin.end(this.script);
    } catch (err) {
      log.warn(`ssh stdin failed for ${host}: ${(err as Error).message}`);
    }

    this.pump(host, child.stdout);

    const result = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
      let settled = false;
      const finish = (value: { code: number | null; error?: Error }): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      child.once("error", (error) => finish({ code: null, error }));
      child.once("exit", (code) => finish({ code }));
    });
    this.children.delete(host);
    this.onGoals?.(host, new Map());
    if (this.stopped) return;
    if (attempt === 0) {
      const reason = result.error?.message ?? `code ${result.code ?? "unknown"}`;
      log.warn(`remote watcher for ${host} exited (${reason}); reconnecting`);
    }
    this.scheduleReconnect(host, attempt);
  }

  private pump(host: string, stream: NodeJS.ReadableStream): void {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        this.consume(host, line);
        nl = buffer.indexOf("\n");
      }
    });
    stream.on("error", (err) => {
      if (!this.stopped) log.warn(`remote stream error for ${host}: ${err.message}`);
    });
  }

  private consume(host: string, line: string): void {
    const message = parseRemoteWatcherMessage(line);
    if (!message) return;
    if (message.kind === "service_tier") {
      this.onServiceTier?.(message.sessionId, message.serviceTier);
      return;
    }
    if (message.kind === "thread_metadata") {
      this.onThreadMetadata?.(message.sessionId, message.title, message.cwd);
      return;
    }
    if (message.kind === "goals") {
      this.onGoals?.(host, message.states);
      return;
    }
    if (message.kind === "monthly_usage") {
      this.onMonthlyUsage?.(host, message.agent, message.usage);
      return;
    }
    const sessionId = sessionIdFromPath(message.file);
    if (!sessionId) return;
    const parsed = parseRollout(message.line);
    if (parsed) this.onEvent(sessionId, true, parsed.event, parsed.at);
  }

  private scheduleReconnect(host: string, attempt: number): void {
    if (this.stopped) return;
    const delay = BACKOFFS_MS[Math.min(attempt, BACKOFFS_MS.length - 1)]!;
    setTimeout(() => void this.run(host, attempt + 1), delay);
  }
}
