import { existsSync, mkdirSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { CodexStore } from "./codex/codex-store.ts";
import { CodexDesktopSelectionWatcher } from "./codex/desktop-selection.ts";
import { CodexGoalWatcher } from "./codex/goal-watcher.ts";
import { CodexResetCreditsWatcher } from "./codex/reset-credits-watcher.ts";
import { CodexMonthlyUsageWatcher, codexMonthlyUsage } from "./codex/monthly-usage.ts";
import { getCodexPlanName } from "./codex/plan-info.ts";
import { buildCodexActivity } from "./codex/presence.ts";
import { RolloutWatcher, type CodexEventSink } from "./codex/rollout-watcher.ts";
import {
  RemoteWatcher,
  discoverRemoteHosts,
  type RemoteMonthlyUsageRaw,
} from "./codex/remote-watcher.ts";
import {
  CodexServiceTierCache,
  CodexThreadSettingsLogWatcher,
  CodexServiceTierWatcher,
} from "./codex/service-tier-watcher.ts";
import { RpcClient } from "./discord/rpc-client.ts";
import { configureLogger, createLogger, getLogFile } from "./util/logger.ts";
import { CODEX_WINDOWS_PROCESS_RULES, ProcessLiveness } from "./util/process-liveness.ts";
import { ProcessRuleTracker, WindowsProcessScanWatcher } from "./util/process-scan-watcher.ts";
import {
  activityAssetsForTheme,
  type ResolvedTheme,
} from "./appearance/theme-assets.ts";
import { CodexThemeWatcher } from "./appearance/theme-watcher.ts";
import type { GoalState, MonthlyUsage } from "./types.ts";

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
configureLogger(config.logFile);

const log = createLogger("main");
process.on("uncaughtException", (err) => {
  log.error(`uncaught exception: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log.error(`unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});
log.info(`logging to ${getLogFile()}`);
log.info(`Codex home: ${config.codexHome}`);
log.info(`presence data: ${config.dataDir}`);

const rpc = new RpcClient(config.applicationId);
const assets = {
  appName: config.appName,
  buttons: [{ label: "Get Codex Presence", url: "https://github.com/dayfinggg/codex-discord-presence" }],
  largeImageKey: config.largeImageKey,
  largeImageKeyLight: config.largeImageKeyLight,
  largeImageKeyDark: config.largeImageKeyDark,
  largeImageUrl: config.largeImageUrl,
  smallImageKey: config.smallImageKey,
  smallImageKeyLight: config.smallImageKeyLight,
  smallImageKeyDark: config.smallImageKeyDark,
  smallImageUrl: config.smallImageUrl,
};
let activeTheme: ResolvedTheme = "light";
let codexPid: number | undefined;

function updateActivity(): void {
  const snapshot = store.snapshot();
  if (!snapshot) {
    log.debug("snapshot: none (cleared)");
    rpc.setActivity(null, codexPid);
    return;
  }
  const activity = buildCodexActivity(snapshot, activityAssetsForTheme(assets, activeTheme));
  log.debug(
    `snapshot: model=${snapshot.model?.displayName ?? "-"} effort=${snapshot.effort ?? "-"} ` +
      `remote=${snapshot.remote ? "yes" : "no"} goal=${snapshot.goalActive ? "yes" : "no"} ` +
      `fast=${snapshot.fastMode ? "yes" : "no"} agents=${snapshot.agentsRunning} → ` +
      `details="${activity.details}" state="${activity.state}" hover="${activity.largeImageText ?? ""}" ` +
      `small="${activity.smallImageKey ?? activity.smallImageUrl ?? ""}" smallHover="${activity.smallImageText ?? ""}"`,
  );
  rpc.setActivity(activity, codexPid);
}

function coalesce(fn: () => void): () => void {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      fn();
    });
  };
}

const store = new CodexStore(coalesce(updateActivity));
const themeWatcher = new CodexThemeWatcher(config.codexHome, (theme) => {
  activeTheme = theme;
  log.info(`appearance theme: ${theme}`);
  updateActivity();
});

function updateLiveness(alive: boolean, startedAt?: number, pid?: number): void {
  const pidChanged = alive && codexPid !== pid;
  if (alive) codexPid = pid;
  store.setAppLiveness(alive, startedAt);
  if (pidChanged) updateActivity();
  if (!alive) codexPid = undefined;
}

const processScan =
  process.platform === "win32"
    ? (() => {
        const tracker = new ProcessRuleTracker("codex", CODEX_WINDOWS_PROCESS_RULES, updateLiveness);
        return new WindowsProcessScanWatcher("^(codex|chatgpt)$", (processes) => tracker.update(processes));
      })()
    : undefined;
const liveness =
  process.platform === "win32"
    ? undefined
    : new ProcessLiveness(/^(?:codex|chatgpt)$/i, updateLiveness);
const desktopSelection = new CodexDesktopSelectionWatcher(config.codexHome, (selection) =>
  store.setDesktopSelection(selection),
);

const goals = new CodexGoalWatcher(config.codexHome, (states) => store.setSessionGoals(false, states));
const remoteGoalSources = new Map<string, ReadonlyMap<string, GoalState>>();
function setRemoteGoals(host: string, states: ReadonlyMap<string, GoalState>): void {
  remoteGoalSources.set(host, states);
  const merged = new Map<string, GoalState>();
  for (const source of remoteGoalSources.values()) {
    for (const [sessionId, state] of source) merged.set(sessionId, state);
  }
  store.setSessionGoals(true, merged);
}
const serviceTierCache = new CodexServiceTierCache(config.serviceTierCacheFile);
for (const entry of serviceTierCache.load()) {
  store.setSessionServiceTier(entry.sessionId, entry.remote, entry.serviceTier);
}
function setSessionServiceTier(sessionId: string, remote: boolean, serviceTier: string | null): void {
  serviceTierCache.set(sessionId, remote, serviceTier);
  store.setSessionServiceTier(sessionId, remote, serviceTier);
}
const serviceTier = new CodexServiceTierWatcher(config.codexHome, (fastMode) =>
  store.setDefaultFastMode(fastMode),
);
const threadSettingsLogs = new CodexThreadSettingsLogWatcher(config.codexHome, (update) => {
  if (update.serviceTier !== undefined) {
    setSessionServiceTier(update.sessionId, false, update.serviceTier);
  }
  if (update.model !== undefined || update.effort !== undefined) {
    store.setSessionThreadSettings(
      update.sessionId,
      false,
      { model: update.model, effort: update.effort },
      update.updatedAt,
    );
  }
});
const resetCredits = new CodexResetCreditsWatcher((available, limits) => {
  store.setResetCreditsAvailable(available);
  store.setAccountLimits(limits);
});
const monthlyUsage = new CodexMonthlyUsageWatcher(config.codexHome, (usage) =>
  store.setMonthlyUsage(false, usage),
);
const remoteMonthlySources = new Map<string, MonthlyUsage>();
function setRemoteMonthlyUsage(host: string, agent: "claude" | "codex", raw: RemoteMonthlyUsageRaw): void {
  if (agent !== "codex") return;
  remoteMonthlySources.set(host, codexMonthlyUsage(raw));
  const aggregate: MonthlyUsage = { totalTokens: 0, costUsd: 0 };
  const addPeriod = (key: "day" | "week" | "allTime", usage: MonthlyUsage): void => {
    const period = usage[key];
    if (!period) return;
    const target = (aggregate[key] ??= { totalTokens: 0, costUsd: 0 });
    target.totalTokens += period.totalTokens;
    target.costUsd += period.costUsd;
  };
  for (const usage of remoteMonthlySources.values()) {
    aggregate.totalTokens += usage.totalTokens;
    aggregate.costUsd += usage.costUsd;
    addPeriod("day", usage);
    addPeriod("week", usage);
    addPeriod("allTime", usage);
  }
  store.setMonthlyUsage(true, aggregate);
}

async function refreshPlan(): Promise<void> {
  if (config.planNameOverride) return;
  try {
    store.setPlanName(await getCodexPlanName(config.codexHome));
  } catch (err) {
    log.warn(`plan refresh failed: ${(err as Error).message}`);
  }
}

let localWatcher: RolloutWatcher | undefined;
let remoteWatcher: RemoteWatcher | undefined;
async function startWatcher(): Promise<void> {
  const sink: CodexEventSink = (sessionId, remote, event, at) =>
    store.handleEvent(sessionId, remote, event, at);

  localWatcher = new RolloutWatcher(config.codexHome, sink);
  const hosts = config.remoteDiscovery
    ? await discoverRemoteHosts(config.codexHome)
    : config.remoteHosts;
  remoteWatcher = new RemoteWatcher(
    hosts,
    sink,
    (sessionId, serviceTier) => setSessionServiceTier(sessionId, true, serviceTier),
    setRemoteGoals,
    setRemoteMonthlyUsage,
    (sessionId, title, cwd) => store.setSessionMetadata(sessionId, true, title, cwd),
  );
  await Promise.all([localWatcher.start(), remoteWatcher.start()]);
}

rpc.start();
themeWatcher.start();
processScan?.start();
liveness?.start();
desktopSelection.start();
goals.start();
serviceTier.start();
threadSettingsLogs.start();
resetCredits.start();
monthlyUsage.start();
if (config.planNameOverride) store.setPlanOverride(config.planNameOverride);
void refreshPlan();
void startWatcher().catch((err) => log.error(`watcher startup failed: ${(err as Error).message}`));
const planTimer = setInterval(() => void refreshPlan(), 30 * 60 * 1000);
const stopFile = process.env.PRESENCE_STOP_FILE?.trim();
let stopFileTimer: ReturnType<typeof setInterval> | undefined;

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`shutting down (${signal})`);
  clearInterval(planTimer);
  if (stopFileTimer) clearInterval(stopFileTimer);
  themeWatcher.stop();
  processScan?.stop();
  liveness?.stop();
  desktopSelection.stop();
  goals.stop();
  serviceTier.stop();
  threadSettingsLogs.stop();
  resetCredits.stop();
  monthlyUsage.stop();
  store.dispose();
  localWatcher?.stop();
  remoteWatcher?.stop();
  await rpc.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
if (stopFile) {
  stopFileTimer = setInterval(() => {
    if (existsSync(stopFile)) void shutdown("autostart removal");
  }, 500);
}

log.info("Codex → Discord Rich Presence started");
