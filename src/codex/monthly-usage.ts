import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import type { MonthlyUsage, UsageTotals } from "../types.ts";
import { createLogger } from "../util/logger.ts";
import { codexCost } from "./cost.ts";

const log = createLogger("codex-monthly");
const DEFAULT_POLL_MS = 60_000;

interface RawUsage {
  input: number;
  cachedInput: number;
  cacheWriteInput: number;
  output: number;
  reasoning: number;
  total: number;
}

export interface UsageEvent extends RawUsage {
  timestamp: string;
  model: string;
}

export interface CodexMonthlyUsageRaw {
  totalTokens: number;
  usageByModel: Record<string, UsageTotals>;
  day?: CodexMonthlyUsageRaw;
  week?: CodexMonthlyUsageRaw;
  allTime?: CodexMonthlyUsageRaw;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function rawUsage(value: unknown): RawUsage | undefined {
  const usage = object(value);
  if (!usage) return undefined;
  const input = count(usage.input_tokens ?? usage.prompt_tokens);
  const cachedInput = Math.min(input, count(usage.cached_input_tokens ?? usage.cached_tokens));
  const cacheWriteInput = Math.min(
    Math.max(0, input - cachedInput),
    count(usage.cache_write_input_tokens ?? usage.cache_write_tokens),
  );
  const output = count(usage.output_tokens ?? usage.completion_tokens);
  const reasoning = count(usage.reasoning_output_tokens);
  const total = count(usage.total_tokens) || input + output;
  return { input, cachedInput, cacheWriteInput, output, reasoning, total };
}

function subtract(current: RawUsage, previous: RawUsage | undefined): RawUsage {
  if (
    previous &&
    (current.input < previous.input ||
      current.cachedInput < previous.cachedInput ||
      current.cacheWriteInput < previous.cacheWriteInput ||
      current.output < previous.output ||
      current.total < previous.total)
  ) return current;
  return {
    input: Math.max(0, current.input - (previous?.input ?? 0)),
    cachedInput: Math.max(0, current.cachedInput - (previous?.cachedInput ?? 0)),
    cacheWriteInput: Math.max(0, current.cacheWriteInput - (previous?.cacheWriteInput ?? 0)),
    output: Math.max(0, current.output - (previous?.output ?? 0)),
    reasoning: Math.max(0, current.reasoning - (previous?.reasoning ?? 0)),
    total: Math.max(0, current.total - (previous?.total ?? 0)),
  };
}

function timestamp(value: unknown): string | undefined {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  return undefined;
}

function modelFrom(value: unknown): string | undefined {
  const record = object(value);
  for (const candidate of [record?.model, record?.model_name]) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return undefined;
}

function nestedUsageEntry(record: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["data", "result", "response"]) {
    const nested = object(record[key]);
    if (nested && object(nested.usage)) return nested;
  }
  return record;
}

function parseLines(lines: Iterable<string>, subagent: boolean): UsageEvent[] {
  const events: UsageEvent[] = [];
  const usageSeconds: string[] = [];
  if (subagent) {
    for (const line of lines) {
      if (!line.includes('"type":"token_count"') && !line.includes('"type": "token_count"')) continue;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        const payload = object(record.payload);
        const info = object(payload?.info);
        if (record.type !== "event_msg" || payload?.type !== "token_count" ||
            (!info?.last_token_usage && !info?.total_token_usage)) continue;
        const at = timestamp(record.timestamp);
        if (at) usageSeconds.push(at.slice(0, 19));
        if (usageSeconds.length === 2) break;
      } catch {
        // Ignore malformed lines while detecting replayed subagent history.
      }
    }
  }
  const replaySecond = usageSeconds.length === 2 && usageSeconds[0] === usageSeconds[1]
    ? usageSeconds[0]
    : undefined;
  let skipReplay = replaySecond !== undefined;
  let currentModel: string | undefined;
  let previousTotals: RawUsage | undefined;

  for (const line of lines) {
    if (line.charCodeAt(0) !== 123) continue;
    if (
      !line.includes("turn_context") &&
      !line.includes("token_count") &&
      !line.includes("usage")
    ) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = record.type;
    const payload = object(record.payload);
    if (type === "turn_context") {
      currentModel = modelFrom(payload) ?? currentModel;
      continue;
    }

    if (type === "event_msg" && payload?.type === "token_count") {
      const info = object(payload.info);
      const total = rawUsage(info?.total_token_usage);
      const at = timestamp(record.timestamp);
      if (skipReplay && at) {
        if (at.slice(0, 19) === replaySecond) {
          if (total) previousTotals = total;
          continue;
        }
        skipReplay = false;
      }
      const last = rawUsage(info?.last_token_usage);
      const usage = total ? subtract(total, previousTotals) : last;
      if (total) previousTotals = total;
      if (!usage || !at) continue;
      if (usage.input === 0 && usage.cachedInput === 0 && usage.cacheWriteInput === 0 && usage.output === 0 && usage.reasoning === 0) continue;
      const model = modelFrom(payload) ?? modelFrom(info) ?? currentModel ?? "gpt-5";
      events.push({ timestamp: at, model, ...usage });
      continue;
    }

    const entry = nestedUsageEntry(record);
    const usage = rawUsage(entry.usage);
    if (!usage) continue;
    const at = timestamp(entry.timestamp ?? entry.created_at ?? entry.createdAt ?? record.timestamp);
    if (!at) continue;
    if (usage.input === 0 && usage.cachedInput === 0 && usage.cacheWriteInput === 0 && usage.output === 0 && usage.reasoning === 0) continue;
    const model = modelFrom(entry) ?? modelFrom(record) ?? currentModel ?? "gpt-5";
    events.push({ timestamp: at, model, ...usage });
  }
  return events;
}

async function isSubagentSession(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(16 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes("thread_spawn");
  } finally {
    await handle.close();
  }
}

async function parseFile(file: string): Promise<UsageEvent[]> {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    const relevantLines: string[] = [];
    for await (const line of lines) {
      if (
        line.charCodeAt(0) === 123 &&
        (line.includes("turn_context") || line.includes("token_count") || line.includes("usage"))
      ) relevantLines.push(line);
    }
    return parseLines(relevantLines, await isSubagentSession(file));
  } finally {
    lines.close();
    input.destroy();
  }
}

async function collectJsonl(dir: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectJsonl(path)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

async function usageFiles(codexHome: string): Promise<string[]> {
  const roots = [join(codexHome, "sessions"), join(codexHome, "archived_sessions")];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const file of await collectJsonl(root)) {
      const key = relative(root, file).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(file);
    }
  }
  return result;
}

export class CodexUsageFileCache {
  readonly entries = new Map<string, { size: number; mtimeMs: number; events: UsageEvent[] }>();
}

export async function readCodexMonthlyUsageRaw(
  codexHome: string,
  now = new Date(),
  cache?: CodexUsageFileCache,
): Promise<CodexMonthlyUsageRaw> {
  const events: UsageEvent[] = [];
  const liveFiles = new Set<string>();
  for (const file of await usageFiles(codexHome)) {
    liveFiles.add(file);
    try {
      let fileEvents: UsageEvent[];
      if (cache) {
        const info = await stat(file);
        const entry = cache.entries.get(file);
        if (entry && entry.size === info.size && entry.mtimeMs === info.mtimeMs) {
          fileEvents = entry.events;
        } else {
          fileEvents = await parseFile(file);
          cache.entries.set(file, { size: info.size, mtimeMs: info.mtimeMs, events: fileEvents });
        }
      } else {
        fileEvents = await parseFile(file);
      }
      for (const event of fileEvents) events.push(event);
    } catch {
      // A session can be rotated while the scan is running; the next poll retries it.
    }
  }
  if (cache) {
    for (const key of cache.entries.keys()) {
      if (!liveFiles.has(key)) cache.entries.delete(key);
    }
  }

  const seen = new Set<string>();
  const unique: UsageEvent[] = [];
  for (const event of events) {
    const key = [
      event.timestamp,
      event.model,
      event.input,
      event.cachedInput,
      event.cacheWriteInput,
      event.output,
      event.reasoning,
      event.total,
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(event);
  }
  const aggregate = (selected: UsageEvent[]): CodexMonthlyUsageRaw => {
    const usageByModel: Record<string, UsageTotals> = {};
    let totalTokens = 0;
    for (const event of selected) {
    const bucket = (usageByModel[event.model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    bucket.input += event.input;
    bucket.output += event.output;
    bucket.cacheRead += event.cachedInput;
    bucket.cacheWrite += event.cacheWriteInput;
    totalTokens += event.total || event.input + event.output;
    }
    return { totalTokens, usageByModel };
  };
  const startDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startWeek = startDay - 6 * 24 * 60 * 60 * 1000;
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const beforeTomorrow = startDay + 24 * 60 * 60 * 1000;
  const within = (start: number) => unique.filter((event) => {
    const at = Date.parse(event.timestamp);
    return at >= start && at < beforeTomorrow;
  });
  return {
    ...aggregate(within(startMonth)),
    day: aggregate(within(startDay)),
    week: aggregate(within(startWeek)),
    allTime: aggregate(unique),
  };
}

export function codexMonthlyUsage(raw: CodexMonthlyUsageRaw): MonthlyUsage {
  const summary = (period: CodexMonthlyUsageRaw) => {
    let costUsd = 0;
    for (const [model, usage] of Object.entries(period.usageByModel)) {
    costUsd += codexCost(model, {
      input: usage.input,
      cachedInput: usage.cacheRead,
      cacheWriteInput: usage.cacheWrite,
      output: usage.output,
    }).total;
    }
    return { totalTokens: period.totalTokens, costUsd };
  };
  return {
    ...summary(raw),
    ...(raw.day ? { day: summary(raw.day) } : {}),
    ...(raw.week ? { week: summary(raw.week) } : {}),
    ...(raw.allTime ? { allTime: summary(raw.allTime) } : {}),
  };
}

function same(a: MonthlyUsage | undefined, b: MonthlyUsage): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class CodexMonthlyUsageWatcher {
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private stopped = false;
  private last?: MonthlyUsage;
  private readonly cache = new CodexUsageFileCache();

  constructor(
    private readonly codexHome: string,
    private readonly onUpdate: (usage: MonthlyUsage) => void,
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
      const usage = codexMonthlyUsage(await readCodexMonthlyUsageRaw(this.codexHome, undefined, this.cache));
      if (!same(this.last, usage)) {
        this.last = usage;
        this.onUpdate(usage);
      }
    } catch (error) {
      log.warn(`monthly usage scan failed: ${(error as Error).message}`);
    } finally {
      this.polling = false;
    }
  }
}
