import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { createLogger } from "../util/logger.ts";

const log = createLogger("codex-service-tier");
const DEFAULT_POLL_MS = 2_000;
const LOG_BATCH_SIZE = 1_000;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_MAX_SESSIONS = 1_000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ServiceTierLogRow {
  id: number;
  ts: number;
  tsNanos: number;
  threadId: string | null;
  body: string;
}

export interface ThreadSettingsUpdate {
  sessionId: string;
  updatedAt: number;
  model?: string;
  effort?: string | null;
  serviceTier?: string | null;
}

export interface ThreadSettingsLogBatch {
  lastId: number;
  updates: ThreadSettingsUpdate[];
}

export interface CachedServiceTier {
  sessionId: string;
  serviceTier: string | null;
  remote: boolean;
}

interface ServiceTierCacheEntry {
  serviceTier: string;
  updatedAt: number;
}

interface ServiceTierCacheFile {
  version: 1;
  sessions: Record<string, ServiceTierCacheEntry>;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function serviceTierFromConfig(raw: string): string | undefined {
  const config = object(parseToml(raw));
  if (!config) return undefined;
  const activeProfile = string(config.profile);
  const profile = activeProfile ? object(object(config.profiles)?.[activeProfile]) : undefined;
  return string(profile?.service_tier) ?? string(config.service_tier);
}

export function serviceTierFromLogBody(body: string): string | null | undefined {
  return threadSettingsFromLogBody(body)?.serviceTier;
}

export function threadSettingsFromLogBody(
  body: string,
): Omit<ThreadSettingsUpdate, "sessionId" | "updatedAt"> | undefined {
  const marker = body.lastIndexOf("thread_settings: ThreadSettingsOverrides {");
  if (marker < 0) return undefined;
  const settings = body.slice(marker);
  const update: Omit<ThreadSettingsUpdate, "sessionId" | "updatedAt"> = {};

  const model = settings.match(/\bmodel:\s*Some\("([^"]+)"\)/);
  if (model?.[1]) update.model = model[1];

  const effort = settings.match(/\beffort:\s*(Some\(Some\(([^)]+)\)\)|Some\(None\)|None)/);
  if (effort) {
    if (effort[2] !== undefined) update.effort = effort[2].trim().toLowerCase();
    else if (effort[1] === "Some(None)") update.effort = null;
  }

  const serviceTier = settings.match(
    /\bservice_tier:\s*(Some\(Some\("([^"]+)"\)\)|Some\(None\)|None)/,
  );
  if (serviceTier) {
    if (serviceTier[2] !== undefined) update.serviceTier = serviceTier[2];
    else if (serviceTier[1] === "Some(None)") update.serviceTier = null;
  }

  return Object.keys(update).length > 0 ? update : undefined;
}

export function readThreadSettingsLogBatch(
  databasePath: string,
  afterId = 0,
  limit = LOG_BATCH_SIZE,
): ThreadSettingsLogBatch {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database
      .prepare(
        `SELECT id, ts, ts_nanos AS tsNanos, thread_id AS threadId, feedback_log_body AS body
         FROM logs
         WHERE id > ?
           AND target = 'codex_core::session::handlers'
           AND feedback_log_body LIKE '%thread_settings: ThreadSettingsOverrides {%'
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(afterId, limit) as unknown as ServiceTierLogRow[];
    let lastId = afterId;
    const latest = new Map<
      string,
      {
        model?: { value: string; updatedAt: number };
        effort?: { value: string | null; updatedAt: number };
        serviceTier?: { value: string | null; updatedAt: number };
      }
    >();
    for (const row of rows.reverse()) {
      lastId = Math.max(lastId, row.id);
      if (!row.threadId) continue;
      const settings = threadSettingsFromLogBody(row.body);
      if (!settings) continue;
      const sessionId = row.threadId.toLowerCase();
      const updatedAt = row.ts * 1_000 + Math.floor(row.tsNanos / 1_000_000);
      const entry = latest.get(sessionId) ?? {};
      if (settings.model !== undefined) entry.model = { value: settings.model, updatedAt };
      if (settings.effort !== undefined) entry.effort = { value: settings.effort, updatedAt };
      if (settings.serviceTier !== undefined) {
        entry.serviceTier = { value: settings.serviceTier, updatedAt };
      }
      latest.set(sessionId, entry);
    }

    const grouped = new Map<string, ThreadSettingsUpdate>();
    for (const [sessionId, fields] of latest) {
      for (const field of ["model", "effort", "serviceTier"] as const) {
        const setting = fields[field];
        if (!setting) continue;
        const key = `${sessionId}:${setting.updatedAt}`;
        const update = grouped.get(key) ?? { sessionId, updatedAt: setting.updatedAt };
        Object.assign(update, { [field]: setting.value });
        grouped.set(key, update);
      }
    }
    return {
      lastId,
      updates: [...grouped.values()].sort(
        (a, b) => a.updatedAt - b.updatedAt || a.sessionId.localeCompare(b.sessionId),
      ),
    };
  } finally {
    database.close();
  }
}

export const readServiceTierLogBatch = readThreadSettingsLogBatch;

export class CodexServiceTierCache {
  private readonly sessions = new Map<string, ServiceTierCacheEntry>();

  constructor(private readonly path: string) {}

  load(now = Date.now()): CachedServiceTier[] {
    this.sessions.clear();
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<ServiceTierCacheFile>;
      if (parsed.version !== 1 || !parsed.sessions || typeof parsed.sessions !== "object") return [];
      for (const [key, entry] of Object.entries(parsed.sessions)) {
        if (!entry || typeof entry !== "object") continue;
        if (typeof entry.serviceTier !== "string" || typeof entry.updatedAt !== "number") continue;
        if (now - entry.updatedAt > CACHE_MAX_AGE_MS) continue;
        const separator = key.indexOf(":");
        if (separator < 0 || !SESSION_ID.test(key.slice(separator + 1))) continue;
        if (key.slice(0, separator) !== "local" && key.slice(0, separator) !== "remote") continue;
        this.sessions.set(key, entry);
      }
    } catch {}
    return [...this.sessions].map(([key, entry]) => {
      const separator = key.indexOf(":");
      return {
        sessionId: key.slice(separator + 1),
        remote: key.slice(0, separator) === "remote",
        serviceTier: entry.serviceTier,
      };
    });
  }

  set(sessionId: string, remote: boolean, serviceTier: string | null, now = Date.now()): void {
    if (!SESSION_ID.test(sessionId)) return;
    const key = `${remote ? "remote" : "local"}:${sessionId.toLowerCase()}`;
    if (serviceTier === null) this.sessions.delete(key);
    else this.sessions.set(key, { serviceTier, updatedAt: now });
    const retained = [...this.sessions]
      .filter(([, entry]) => now - entry.updatedAt <= CACHE_MAX_AGE_MS)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, CACHE_MAX_SESSIONS);
    this.sessions.clear();
    for (const [retainedKey, entry] of retained) this.sessions.set(retainedKey, entry);
    const file: ServiceTierCacheFile = { version: 1, sessions: Object.fromEntries(this.sessions) };
    try {
      writeFileSync(this.path, JSON.stringify(file), "utf8");
    } catch (err) {
      log.debug(`service tier cache write failed: ${(err as Error).message}`);
    }
  }
}

export class CodexServiceTierWatcher {
  private timer?: ReturnType<typeof setInterval>;
  private lastFastMode?: boolean;
  private stopped = false;
  private polling = false;

  constructor(
    private readonly codexHome: string,
    private readonly onUpdate: (fastMode: boolean) => void,
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
      const tier = serviceTierFromConfig(await readFile(join(this.codexHome, "config.toml"), "utf8"));
      const fastMode = tier === "priority" || tier === "fast";
      if (fastMode === this.lastFastMode) return;
      this.lastFastMode = fastMode;
      log.debug(`fast=${fastMode ? "yes" : "no"}`);
      this.onUpdate(fastMode);
    } catch (err) {
      log.debug(`service tier poll failed: ${(err as Error).message}`);
    } finally {
      this.polling = false;
    }
  }
}

export class CodexThreadSettingsLogWatcher {
  private timer?: ReturnType<typeof setInterval>;
  private lastId = 0;
  private stopped = false;

  constructor(
    private readonly codexHome: string,
    private readonly onUpdate: (update: ThreadSettingsUpdate) => void,
    private readonly intervalMs = DEFAULT_POLL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private poll(): void {
    if (this.stopped) return;
    try {
      const batch = readThreadSettingsLogBatch(join(this.codexHome, "logs_2.sqlite"), this.lastId);
      this.lastId = batch.lastId;
      for (const update of batch.updates) this.onUpdate(update);
    } catch (err) {
      log.debug(`service tier log poll failed: ${(err as Error).message}`);
    }
  }
}

export const CodexServiceTierLogWatcher = CodexThreadSettingsLogWatcher;
