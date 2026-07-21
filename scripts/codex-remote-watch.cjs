"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
let DatabaseSync;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (e) {}

const HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const SESSIONS = path.join(HOME, "sessions");
const ARCHIVED_SESSIONS = path.join(HOME, "archived_sessions");
const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const POLL_MS = 1000;
const HEARTBEAT_MS = 20000;
const SERVICE_TIER_POLL_MS = 2000;
const MONTHLY_USAGE_POLL_MS = 60_000;
const TAIL_BYTES = 256 * 1024;
const TRACK_IDLE_MS = 15 * 60 * 1000;
const PRIME_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const tracked = new Map();
let serviceTierDatabase;
let serviceTierStatement;
let lastServiceTierLogId = 0;
let defaultServiceTier = "default";
const sessionServiceTiers = new Map();
let goalDatabase;
let goalStatement;
let lastGoalStateKey;
const lastMonthlyState = new Map();

process.stdout.on("error", () => process.exit(0));

function emit(file, line) {
  try {
    process.stdout.write(JSON.stringify({ f: file, l: line }) + "\n");
  } catch (e) {
    process.exit(0);
  }
}

function emitServiceTier(sessionId, serviceTier) {
  try {
    process.stdout.write(JSON.stringify({ s: sessionId, t: serviceTier }) + "\n");
  } catch (e) {
    process.exit(0);
  }
}

function emitGoals(states) {
  try {
    process.stdout.write(
      JSON.stringify({
        G: states.map((state) => ({
          s: state.sessionId,
          ...(state.elapsedSeconds !== undefined ? { e: state.elapsedSeconds } : {}),
          ...(state.startedAt !== undefined ? { c: state.startedAt } : {}),
          ...(state.updatedAt !== undefined ? { u: state.updatedAt } : {}),
        })),
      }) + "\n",
    );
  } catch (e) {
    process.exit(0);
  }
}

function emitMonthly(agent, usage) {
  const compact = (period) => {
    const models = {};
    for (const [model, value] of Object.entries(period.usageByModel)) {
      models[model] = {
      i: value.input,
      o: value.output,
      r: value.cacheRead,
      w: value.cacheWrite,
      ...(value.cacheWriteOneHour ? { h: value.cacheWriteOneHour } : {}),
    };
    }
    return { T: period.totalTokens, U: models };
  };
  const message = {
    M: agent,
    ...compact(usage),
    ...(usage.day ? { D: compact(usage.day) } : {}),
    ...(usage.week ? { W: compact(usage.week) } : {}),
    ...(usage.allTime ? { A: compact(usage.allTime) } : {}),
  };
  const key = JSON.stringify(message);
  if (lastMonthlyState.get(agent) === key) return;
  lastMonthlyState.set(agent, key);
  try {
    process.stdout.write(key + "\n");
  } catch (e) {
    process.exit(0);
  }
}

function positiveCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function usageRecord(value) {
  const usage = record(value);
  if (!usage) return undefined;
  const input = positiveCount(usage.input_tokens ?? usage.prompt_tokens);
  const cachedInput = Math.min(input, positiveCount(usage.cached_input_tokens ?? usage.cached_tokens));
  const output = positiveCount(usage.output_tokens ?? usage.completion_tokens);
  const reasoning = positiveCount(usage.reasoning_output_tokens);
  const total = positiveCount(usage.total_tokens) || input + output;
  return { input, cachedInput, output, reasoning, total };
}

function usageDelta(current, previous) {
  return {
    input: Math.max(0, current.input - (previous?.input || 0)),
    cachedInput: Math.max(0, current.cachedInput - (previous?.cachedInput || 0)),
    output: Math.max(0, current.output - (previous?.output || 0)),
    reasoning: Math.max(0, current.reasoning - (previous?.reasoning || 0)),
    total: Math.max(0, current.total - (previous?.total || 0)),
  };
}

function timestamp(value) {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  return undefined;
}

function modelFrom(value) {
  const obj = record(value);
  for (const candidate of [obj?.model, obj?.model_name]) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return undefined;
}

function addUsage(target, model, usage) {
  const bucket = (target[model] ||= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  bucket.input += usage.input;
  bucket.output += usage.output;
  bucket.cacheRead += usage.cacheRead;
  bucket.cacheWrite += usage.cacheWrite;
  if (usage.cacheWriteOneHour) bucket.cacheWriteOneHour = (bucket.cacheWriteOneHour || 0) + usage.cacheWriteOneHour;
}

function usagePeriods(events, aggregate, now = new Date()) {
  const startDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startWeek = startDay - 6 * 24 * 60 * 60 * 1000;
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const beforeTomorrow = startDay + 24 * 60 * 60 * 1000;
  const within = (start) => events.filter((event) => {
    const at = Date.parse(event.at);
    return at >= start && at < beforeTomorrow;
  });
  return {
    ...aggregate(within(startMonth)),
    day: aggregate(within(startDay)),
    week: aggregate(within(startWeek)),
    allTime: aggregate(events),
  };
}

function listJsonl(root) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
    }
  };
  walk(root);
  return files;
}

function codexMonthlyUsage() {
  const files = [];
  const seenFiles = new Set();
  for (const root of [SESSIONS, ARCHIVED_SESSIONS]) {
    for (const file of listJsonl(root)) {
      const key = path.relative(root, file).toLowerCase();
      if (seenFiles.has(key)) continue;
      seenFiles.add(key);
      files.push(file);
    }
  }

  const events = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      continue;
    }
    const lines = text.split(/\r?\n/);
    const subagent = text.slice(0, 16 * 1024).includes("thread_spawn");
    const usageSeconds = [];
    if (subagent) {
      for (const line of lines) {
        if (!line.includes('"type":"token_count"') && !line.includes('"type": "token_count"')) continue;
        try {
          const value = JSON.parse(line);
          const payload = record(value.payload);
          const info = record(payload?.info);
          if (value.type !== "event_msg" || payload?.type !== "token_count" ||
              (!info?.last_token_usage && !info?.total_token_usage)) continue;
          const at = timestamp(value.timestamp);
          if (at) usageSeconds.push(at.slice(0, 19));
          if (usageSeconds.length === 2) break;
        } catch (e) {}
      }
    }
    const replaySecond = usageSeconds.length === 2 && usageSeconds[0] === usageSeconds[1]
      ? usageSeconds[0]
      : undefined;
    let skipReplay = replaySecond !== undefined;
    let currentModel;
    let previousTotals;
    for (const line of lines) {
      if (line.charCodeAt(0) !== 123) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch (e) {
        continue;
      }
      const payload = record(value.payload);
      if (value.type === "turn_context") {
        currentModel = modelFrom(payload) || currentModel;
        continue;
      }
      if (value.type === "event_msg" && payload?.type === "token_count") {
        const info = record(payload.info);
        const total = usageRecord(info?.total_token_usage);
        const at = timestamp(value.timestamp);
        if (skipReplay && at) {
          if (at.slice(0, 19) === replaySecond) {
            if (total) previousTotals = total;
            continue;
          }
          skipReplay = false;
        }
        const last = usageRecord(info?.last_token_usage);
        const usage = last || (total ? usageDelta(total, previousTotals) : undefined);
        if (total) previousTotals = total;
        if (!usage || !at) continue;
        if (usage.input === 0 && usage.cachedInput === 0 && usage.output === 0 && usage.reasoning === 0) continue;
        events.push({ at, model: modelFrom(payload) || modelFrom(info) || currentModel || "gpt-5", ...usage });
        continue;
      }
      let entry = value;
      for (const key of ["data", "result", "response"]) {
        const nested = record(value[key]);
        if (nested && record(nested.usage)) {
          entry = nested;
          break;
        }
      }
      const usage = usageRecord(entry.usage);
      const at = timestamp(entry.timestamp ?? entry.created_at ?? entry.createdAt ?? value.timestamp);
      if (!usage || !at) continue;
      if (usage.input === 0 && usage.cachedInput === 0 && usage.output === 0 && usage.reasoning === 0) continue;
      events.push({ at, model: modelFrom(entry) || modelFrom(value) || currentModel || "gpt-5", ...usage });
    }
  }

  const seen = new Set();
  const unique = [];
  for (const event of events) {
    const key = [event.at, event.model, event.input, event.cachedInput, event.output, event.reasoning, event.total].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(event);
  }
  return usagePeriods(unique, (selected) => {
    const usageByModel = {};
    let totalTokens = 0;
    for (const event of selected) {
      addUsage(usageByModel, event.model, {
        input: event.input,
        output: event.output,
        cacheRead: event.cachedInput,
        cacheWrite: 0,
      });
      totalTokens += event.total || event.input + event.output;
    }
    return { totalTokens, usageByModel };
  });
}

function claudeConfigDirs() {
  if (process.env.CLAUDE_CONFIG_DIR) {
    return process.env.CLAUDE_CONFIG_DIR.split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => (path.basename(value).toLowerCase() === "projects" ? path.dirname(value) : value));
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return [path.join(xdg, "claude"), CLAUDE_CONFIG_DIR];
}

function claudeMonthlyUsage() {
  const deduped = [];
  const exact = new Map();
  const byMessage = new Map();
  const anonymous = [];
  for (const configDir of claudeConfigDirs()) {
    for (const file of listJsonl(path.join(configDir, "projects"))) {
      let text;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch (e) {
        continue;
      }
      for (const line of text.split(/\r?\n/)) {
        if (line.charCodeAt(0) !== 123 || !line.includes('"usage"')) continue;
        let value;
        try {
          value = JSON.parse(line);
        } catch (e) {
          continue;
        }
        const wrapped = record(record(value.data)?.message);
        const entry = wrapped && record(wrapped.message) ? wrapped : value;
        const message = record(entry.message);
        const raw = record(message?.usage);
        const at = timestamp(entry.timestamp);
        const model = message?.model;
        if (!raw || !at || typeof model !== "string" || model.trim() === "") continue;
        const cacheCreation = record(raw.cache_creation);
        const oneHour = positiveCount(cacheCreation?.ephemeral_1h_input_tokens);
        const fiveMinute = positiveCount(cacheCreation?.ephemeral_5m_input_tokens);
        const usage = {
          input: positiveCount(raw.input_tokens),
          output: positiveCount(raw.output_tokens),
          cacheRead: positiveCount(raw.cache_read_input_tokens),
          cacheWrite: cacheCreation ? oneHour + fiveMinute : positiveCount(raw.cache_creation_input_tokens),
        };
        if (oneHour > 0) usage.cacheWriteOneHour = Math.min(usage.cacheWrite, oneHour);
        const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
        if (total === 0) continue;
        const requestId = typeof entry.requestId === "string" && entry.requestId !== "" ? entry.requestId : undefined;
        const event = {
          at,
          model: raw.speed === "fast" ? `${model}-fast` : model,
          usage,
          total,
          requestId,
          sidechain: entry.isSidechain === true,
        };
        const id = typeof message.id === "string" && message.id !== "" ? message.id : undefined;
        if (!id) {
          anonymous.push(event);
          continue;
        }
        const exactKey = `${id}\u0000${requestId || ""}`;
        let index = exact.get(exactKey);
        if (index !== undefined && deduped[index]?.requestId !== requestId) index = undefined;
        if (index === undefined) {
          index = byMessage.get(id)?.find((candidate) => event.sidechain || deduped[candidate]?.sidechain === true);
        }
        if (index === undefined) {
          index = deduped.length;
          deduped.push(event);
          exact.set(exactKey, index);
          const indexes = byMessage.get(id) || [];
          indexes.push(index);
          byMessage.set(id, indexes);
          continue;
        }
        const existing = deduped[index];
        if ((existing.sidechain !== event.sidechain && !event.sidechain) ||
            (existing.sidechain === event.sidechain && event.total > existing.total)) {
          deduped[index] = event;
          exact.set(exactKey, index);
        }
      }
    }
  }

  return usagePeriods([...deduped, ...anonymous], (selected) => {
    const usageByModel = {};
    let totalTokens = 0;
    for (const event of selected) {
      addUsage(usageByModel, event.model, event.usage);
      totalTokens += event.total;
    }
    return { totalTokens, usageByModel };
  });
}

function scanMonthlyUsage() {
  try {
    emitMonthly("codex", codexMonthlyUsage());
  } catch (e) {}
  try {
    emitMonthly("claude", claudeMonthlyUsage());
  } catch (e) {}
}

function scanGoal() {
  if (!DatabaseSync) return;
  try {
    if (!goalDatabase) {
      goalDatabase = new DatabaseSync(path.join(HOME, "goals_1.sqlite"), { readOnly: true });
      goalStatement = goalDatabase.prepare(
        `SELECT thread_id AS sessionId,
                time_used_seconds AS elapsedSeconds,
                created_at_ms AS startedAt,
                updated_at_ms AS updatedAt
           FROM thread_goals
          WHERE status = 'active'
          ORDER BY thread_id`,
      );
    }
    const states = goalStatement.all().map((row) => ({
      sessionId: String(row.sessionId).toLowerCase(),
      elapsedSeconds: Math.max(0, Number(row.elapsedSeconds) || 0),
      startedAt: Math.max(0, Number(row.startedAt) || 0),
      updatedAt: Math.max(0, Number(row.updatedAt) || 0),
    }));
    const stateKey = states
      .map((state) => `${state.sessionId}:${state.startedAt || "unknown"}:${Math.floor(state.elapsedSeconds / 60)}`)
      .join("|");
    if (stateKey === lastGoalStateKey) return;
    lastGoalStateKey = stateKey;
    emitGoals(states);
  } catch (e) {
    try {
      goalDatabase?.close();
    } catch (closeError) {}
    goalDatabase = undefined;
    goalStatement = undefined;
  }
}

function serviceTierFromLogBody(body) {
  const marker = body.lastIndexOf("thread_settings: ThreadSettingsOverrides {");
  if (marker < 0) return undefined;
  const match = body
    .slice(marker)
    .match(/service_tier:\s*(?:Some\(Some\("([^"]+)"\)\)|Some\(None\)|None)/);
  if (!match) return undefined;
  if (match[1] !== undefined) return match[1];
  return match[0].endsWith("Some(None)") ? null : undefined;
}

function tomlString(value) {
  const match = value.match(/^"((?:[^"\\]|\\.)*)"/);
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch (e) {
    return undefined;
  }
}

function serviceTierFromConfig() {
  let raw;
  try {
    raw = fs.readFileSync(path.join(HOME, "config.toml"), "utf8");
  } catch (e) {
    return "default";
  }
  let section = "";
  let activeProfile;
  let globalTier;
  const profileTiers = new Map();
  for (const sourceLine of raw.split(/\r?\n/)) {
    const line = sourceLine.trim();
    const sectionMatch = line.match(/^\[([^\]]+)\]/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    const keyMatch = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!keyMatch) continue;
    const value = tomlString(keyMatch[2]);
    if (value === undefined) continue;
    if (section === "" && keyMatch[1] === "profile") activeProfile = value;
    if (section === "" && keyMatch[1] === "service_tier") globalTier = value;
    if (section.startsWith("profiles.") && keyMatch[1] === "service_tier") {
      profileTiers.set(section.slice("profiles.".length).replace(/^"|"$/g, ""), value);
    }
  }
  return (activeProfile && profileTiers.get(activeProfile)) || globalTier || "default";
}

function sessionIdFromFile(file) {
  const match = path
    .basename(file)
    .match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match ? match[1].toLowerCase() : undefined;
}

function effectiveServiceTier(sessionId) {
  const override = sessionServiceTiers.get(sessionId);
  return override === undefined || override === null ? defaultServiceTier : override;
}

function refreshDefaultServiceTier() {
  const next = serviceTierFromConfig();
  if (next === defaultServiceTier) return;
  defaultServiceTier = next;
  const emitted = new Set();
  for (const file of tracked.keys()) {
    const sessionId = sessionIdFromFile(file);
    if (!sessionId || emitted.has(sessionId)) continue;
    emitted.add(sessionId);
    const override = sessionServiceTiers.get(sessionId);
    if (override === undefined || override === null) emitServiceTier(sessionId, defaultServiceTier);
  }
}

function openServiceTierDatabase() {
  if (!DatabaseSync || serviceTierDatabase) return;
  serviceTierDatabase = new DatabaseSync(path.join(HOME, "logs_2.sqlite"), { readOnly: true });
  serviceTierStatement = serviceTierDatabase.prepare(`
    SELECT id, thread_id AS threadId, feedback_log_body AS body
    FROM logs
    WHERE id > ?
      AND target = 'codex_core::session::handlers'
      AND feedback_log_body LIKE '%thread_settings: ThreadSettingsOverrides {%'
    ORDER BY id DESC
    LIMIT 1000
  `);
}

function scanServiceTiers() {
  try {
    refreshDefaultServiceTier();
    openServiceTierDatabase();
    if (!serviceTierStatement) return;
    const rows = serviceTierStatement.all(lastServiceTierLogId).reverse();
    const latest = new Map();
    for (const row of rows) {
      lastServiceTierLogId = Math.max(lastServiceTierLogId, row.id);
      if (typeof row.threadId !== "string" || !SESSION_ID.test(row.threadId)) continue;
      const serviceTier = serviceTierFromLogBody(row.body);
      if (serviceTier !== undefined) latest.set(row.threadId.toLowerCase(), serviceTier);
    }
    for (const [sessionId, serviceTier] of latest) {
      sessionServiceTiers.set(sessionId, serviceTier);
      emitServiceTier(sessionId, effectiveServiceTier(sessionId));
    }
  } catch (e) {
    try {
      serviceTierDatabase?.close();
    } catch (closeError) {}
    serviceTierDatabase = undefined;
    serviceTierStatement = undefined;
  }
}

function listRecent() {
  const out = [];
  const cutoff = Date.now() - PRIME_MAX_AGE_MS;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "archived_sessions") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".jsonl")) {
        try {
          const info = fs.statSync(full);
          if (info.mtimeMs >= cutoff) out.push(full);
        } catch (e) {}
      }
    }
  };
  walk(SESSIONS);
  return out;
}

function readRange(file, start, length) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const bytes = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

const HEAD_CHUNK_BYTES = 1024 * 1024;
const CONTEXT_MARKERS = ['"session_meta"', '"turn_context"', '"thread_settings_applied"'];

function primeHeadContext(file, end) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch (e) {
    return;
  }
  try {
    const buf = Buffer.alloc(Math.min(HEAD_CHUNK_BYTES, end));
    let offset = 0;
    let leftover = Buffer.alloc(0);
    while (offset < end) {
      const length = Math.min(buf.length, end - offset);
      const bytes = fs.readSync(fd, buf, 0, length, offset);
      if (bytes <= 0) break;
      offset += bytes;
      const combined = Buffer.concat([leftover, buf.subarray(0, bytes)]);
      const lastNl = combined.lastIndexOf(0x0a);
      if (lastNl < 0) {
        leftover = combined;
        continue;
      }
      const complete = combined.subarray(0, lastNl).toString("utf8");
      leftover = Buffer.from(combined.subarray(lastNl + 1));
      for (const line of complete.split("\n")) {
        if (line.trim() === "") continue;
        if (CONTEXT_MARKERS.some((marker) => line.includes(marker))) emit(file, line);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

function prime(file) {
  let info;
  try {
    info = fs.statSync(file);
  } catch (e) {
    return;
  }
  const size = info.size;
  tracked.set(file, { offset: size, leftover: Buffer.alloc(0), lastSeen: Date.now() });
  const sessionId = sessionIdFromFile(file);
  if (sessionId) emitServiceTier(sessionId, effectiveServiceTier(sessionId));
  if (size === 0) return;
  const start = Math.max(0, size - TAIL_BYTES);
  if (start > 0) primeHeadContext(file, start);
  let text = readRange(file, start, size - start).toString("utf8");
  if (start > 0) {
    const cut = text.indexOf("\n");
    text = cut >= 0 ? text.slice(cut + 1) : "";
  }
  for (const line of text.split("\n")) {
    if (line.trim() !== "") emit(file, line);
  }
}

function readGrowth(file) {
  let info;
  try {
    info = fs.statSync(file);
  } catch (e) {
    return;
  }
  const entry = tracked.get(file);
  if (!entry) {
    prime(file);
    return;
  }
  if (info.size < entry.offset) {
    entry.offset = 0;
    entry.leftover = Buffer.alloc(0);
  }
  if (info.size === entry.offset) return;
  const chunk = readRange(file, entry.offset, info.size - entry.offset);
  entry.offset += chunk.length;
  entry.lastSeen = Date.now();
  const combined = Buffer.concat([entry.leftover, chunk]);
  const lastNl = combined.lastIndexOf(0x0a);
  if (lastNl < 0) {
    entry.leftover = combined;
    return;
  }
  const complete = combined.subarray(0, lastNl).toString("utf8");
  entry.leftover = combined.subarray(lastNl + 1);
  for (const line of complete.split("\n")) {
    if (line.trim() !== "") emit(file, line);
  }
}

function poll() {
  const now = Date.now();
  const recent = listRecent();
  for (const file of recent) {
    if (!tracked.has(file)) prime(file);
    else readGrowth(file);
  }
  for (const [file, entry] of tracked) {
    if (now - entry.lastSeen > TRACK_IDLE_MS && !recent.includes(file)) tracked.delete(file);
  }
}

defaultServiceTier = serviceTierFromConfig();
scanGoal();
scanServiceTiers();
scanMonthlyUsage();
for (const file of listRecent()) prime(file);
setInterval(poll, POLL_MS);
setInterval(scanServiceTiers, SERVICE_TIER_POLL_MS);
setInterval(scanGoal, SERVICE_TIER_POLL_MS);
setInterval(scanMonthlyUsage, MONTHLY_USAGE_POLL_MS);
setInterval(() => {
  try {
    process.stdout.write("\n");
  } catch (e) {
    process.exit(0);
  }
}, HEARTBEAT_MS);
