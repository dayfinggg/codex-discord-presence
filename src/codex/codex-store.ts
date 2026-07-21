import type {
  EffortLevel,
  GoalState,
  Limits,
  ModelInfo,
  MonthlyUsage,
  PresenceState,
  SessionStatus,
  UsageTotals,
} from "../types.ts";
import { mergeLimits } from "../limits.ts";
import { codexToolLabel } from "./tool-labels.ts";
import { codexCost } from "./cost.ts";
import { codexModelDisplayName } from "./presence.ts";
import { planName as planNameFor } from "./plan-info.ts";
import type { CodexEvent, CodexRateLimits } from "./rollout-parser.ts";
import type { CodexDesktopSelection } from "./desktop-selection.ts";

const IDLE_MS = 10 * 60 * 1000;
const AGENT_IDLE_MS = 5 * 60 * 1000;
const APP_CLOSE_GRACE_MS = 45_000;
const FIVE_HOUR_MINUTES = 5 * 60;
const SEVEN_DAY_MINUTES = 7 * 24 * 60;
const WINDOW_TOLERANCE_MINUTES = 5;
const EFFORT_LEVELS: ReadonlySet<string> = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

interface CodexSession {
  sessionId: string;
  remote: boolean;
  isSubagent: boolean;
  parentThreadId?: string;
  cwd?: string;
  ended: boolean;
  startTimestamp: number;
  lastActivity: number;
  lastInteractionAt: number;
  model?: ModelInfo;
  modelUpdatedAt?: number;
  effort?: EffortLevel;
  effortUpdatedAt?: number;
  planMode: boolean;
  realtime: boolean;
  fastMode?: boolean;
  status: SessionStatus;
  thinkingStartedAt?: number;
  action: string;
  usage?: UsageTotals;
  usageByModel: Record<string, UsageTotals>;
  contextWindow?: number;
  contextUsed?: number;
}

interface TimedThreadSettings {
  model?: { value: string; updatedAt: number };
  effort?: { value: EffortLevel | undefined; updatedAt: number };
}

function effortOf(raw: string | undefined): EffortLevel | undefined {
  return raw !== undefined && EFFORT_LEVELS.has(raw) ? (raw as EffortLevel) : undefined;
}

function statusRank(status: SessionStatus): number {
  switch (status) {
    case "working":
    case "thinking":
      return 2;
    case "waiting":
    case "new":
      return 1;
    case "idle":
      return 0;
  }
}

function actionForStatus(status: SessionStatus, working: string): string {
  switch (status) {
    case "new":
      return "Waiting for a prompt";
    case "thinking":
      return "Thinking";
    case "idle":
      return "Idle";
    case "waiting":
      return "Waiting for input";
    case "working":
      return working;
  }
}

function limitsFromCodex(rl: CodexRateLimits, at: number): Limits | undefined {
  if (rl.primary && rl.secondary && rl.primary.usedPercent === 0 && rl.secondary.usedPercent === 0) {
    return undefined;
  }
  const limits: Limits = { updatedAt: at };
  for (const window of [rl.primary, rl.secondary]) {
    if (!window) continue;
    const value = { usedPercentage: window.usedPercent, resetsAt: toMs(window.resetsAt) };
    if (
      window.windowMinutes !== undefined &&
      Math.abs(window.windowMinutes - FIVE_HOUR_MINUTES) <= WINDOW_TOLERANCE_MINUTES
    ) {
      limits.fiveHour = value;
    } else if (
      window.windowMinutes !== undefined &&
      Math.abs(window.windowMinutes - SEVEN_DAY_MINUTES) <= WINDOW_TOLERANCE_MINUTES
    ) {
      limits.sevenDay = value;
    }
  }
  if (!limits.fiveHour && !limits.sevenDay) return undefined;
  return limits;
}

function toMs(seconds: number | undefined): number | undefined {
  if (seconds === undefined) return undefined;
  return seconds < 1e12 ? Math.round(seconds * 1000) : Math.round(seconds);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function goalStateEquals(a: GoalState, b: GoalState | undefined): boolean {
  return (
    b !== undefined &&
    a.active === b.active &&
    a.elapsedSeconds === b.elapsedSeconds &&
    a.startedAt === b.startedAt &&
    a.updatedAt === b.updatedAt
  );
}

export class CodexStore {
  private readonly sessions = new Map<string, CodexSession>();
  private activeId?: string;
  private planName?: string;
  private planOverride?: string;
  private resetCreditsAvailable?: number;
  private rolloutLimits?: Limits;
  private appServerLimits?: Limits;
  private localMonthlyUsage?: MonthlyUsage;
  private remoteMonthlyUsage?: MonthlyUsage;
  private readonly sessionGoals = new Map<string, GoalState>();
  private defaultFastMode = false;
  private readonly sessionServiceTiers = new Map<string, string | null>();
  private readonly sessionThreadSettings = new Map<string, TimedThreadSettings>();
  private activeSince?: number;
  private appAlive = false;
  private appLivenessKnown = false;
  private appStartedAt?: number;
  private desktopSelection?: CodexDesktopSelection;
  private cleared = false;
  private readonly appCloseGraceMs: number;
  private readonly idleTimer: ReturnType<typeof setInterval>;

  constructor(private readonly onChange: () => void, options: { appCloseGraceMs?: number } = {}) {
    this.appCloseGraceMs = options.appCloseGraceMs ?? APP_CLOSE_GRACE_MS;
    this.idleTimer = setInterval(() => this.checkIdle(), 5_000);
  }

  dispose(): void {
    clearInterval(this.idleTimer);
  }

  setMonthlyUsage(remote: boolean, usage: MonthlyUsage): void {
    const current = remote ? this.remoteMonthlyUsage : this.localMonthlyUsage;
    if (
      current?.totalTokens === usage.totalTokens &&
      Math.abs((current?.costUsd ?? 0) - usage.costUsd) < 1e-9
    ) {
      return;
    }
    if (remote) this.remoteMonthlyUsage = usage;
    else this.localMonthlyUsage = usage;
    this.onChange();
  }

  private ensure(sessionId: string, remote: boolean, at: number): CodexSession {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        remote,
        isSubagent: false,
        ended: false,
        startTimestamp: at,
        lastActivity: at,
        lastInteractionAt: 0,
        planMode: false,
        realtime: false,
        status: "new",
        action: "Waiting for a prompt",
        usageByModel: {},
      };
      this.sessions.set(sessionId, session);
    }
    session.remote = remote;
    const serviceTierKey = this.scopedSessionKey(sessionId, remote);
    if (this.sessionServiceTiers.has(serviceTierKey)) {
      this.applyServiceTier(session, this.sessionServiceTiers.get(serviceTierKey)!);
    }
    const settings = this.sessionThreadSettings.get(serviceTierKey);
    if (settings?.model) this.applyModel(session, settings.model.value, settings.model.updatedAt);
    if (settings?.effort) this.applyEffort(session, settings.effort.value, settings.effort.updatedAt);
    const settingsAt = Math.max(settings?.model?.updatedAt ?? 0, settings?.effort?.updatedAt ?? 0);
    if (settingsAt > session.lastActivity) session.lastActivity = settingsAt;
    if (settingsAt > session.lastInteractionAt) session.lastInteractionAt = settingsAt;
    return session;
  }

  private scopedSessionKey(sessionId: string, remote: boolean): string {
    return `${remote ? "remote" : "local"}:${sessionId.toLowerCase()}`;
  }

  private applyServiceTier(session: CodexSession, serviceTier: string | null): void {
    session.fastMode = serviceTier === null ? undefined : serviceTier === "priority";
  }

  private applyModel(session: CodexSession, model: string, updatedAt: number): boolean {
    if (session.modelUpdatedAt !== undefined && updatedAt < session.modelUpdatedAt) return false;
    session.modelUpdatedAt = updatedAt;
    const next = { id: model, displayName: codexModelDisplayName(model) };
    if (session.model?.id === next.id && session.model.displayName === next.displayName) return false;
    session.model = next;
    return true;
  }

  private applyEffort(
    session: CodexSession,
    effort: EffortLevel | undefined,
    updatedAt: number,
  ): boolean {
    if (session.effortUpdatedAt !== undefined && updatedAt < session.effortUpdatedAt) return false;
    session.effortUpdatedAt = updatedAt;
    if (session.effort === effort) return false;
    if (effort === undefined) delete session.effort;
    else session.effort = effort;
    return true;
  }

  handleEvent(sessionId: string, remote: boolean, event: CodexEvent, at?: number): void {
    const when = at ?? Date.now();
    const session = this.ensure(sessionId, remote, when);
    const wasThinking = session.status === "thinking";
    if (when > session.lastActivity) session.lastActivity = when;
    this.cleared = false;
    const activityEvent =
      event.kind === "session_meta" ||
      event.kind === "user_message" ||
      event.kind === "task_started" ||
      event.kind === "tool" ||
      event.kind === "reasoning";
    if (activityEvent) session.ended = false;

    switch (event.kind) {
      case "session_meta":
        session.isSubagent = event.isSubagent;
        session.parentThreadId = event.parentThreadId?.toLowerCase();
        if (event.cwd) session.cwd = event.cwd;
        if (event.isSubagent) {
          session.status = "working";
          session.action = "Working";
        }
        break;
      case "turn_context":
        if (event.model) this.applyModel(session, event.model, when);
        {
          const effort = effortOf(event.effort);
          if (effort) this.applyEffort(session, effort, when);
        }
        session.planMode = event.planMode;
        session.realtime = event.realtime;
        if (event.serviceTier !== undefined) this.applyServiceTier(session, event.serviceTier);
        break;
      case "thread_settings":
        if (event.model) this.applyModel(session, event.model, when);
        {
          const effort = effortOf(event.effort);
          if (effort) this.applyEffort(session, effort, when);
        }
        if (event.planMode !== undefined) session.planMode = event.planMode;
        if (event.serviceTier !== undefined) this.applyServiceTier(session, event.serviceTier);
        break;
      case "user_message":
        session.status = "thinking";
        session.action = "Thinking";
        if (when > session.lastInteractionAt) session.lastInteractionAt = when;
        break;
      case "task_started":
        if (event.contextWindow) session.contextWindow = event.contextWindow;
        if (session.status === "new" || session.status === "idle") {
          session.status = "thinking";
          session.action = "Thinking";
        }
        break;
      case "tool":
        session.status = "working";
        session.action = codexToolLabel(event.name, event.file, event.server);
        break;
      case "reasoning":
        if (session.status === "new" || session.status === "idle" || session.status === "waiting") {
          session.status = "thinking";
          session.action = "Thinking";
        }
        break;
      case "request_user_input":
        session.status = "waiting";
        session.action = "Waiting for input";
        break;
      case "turn_ended":
        session.status = "idle";
        session.action = "Idle";
        if (session.isSubagent) session.ended = true;
        break;
      case "token_count": {
        const cumulative: UsageTotals = {
          input: event.usage.input,
          output: event.usage.output,
          cacheRead: event.usage.cachedInput,
          cacheWrite: 0,
        };
        const prev = session.usage;
        const reset = prev !== undefined && (cumulative.input < prev.input || cumulative.output < prev.output);
        const delta =
          prev && !reset
            ? {
                input: Math.max(0, cumulative.input - prev.input),
                output: Math.max(0, cumulative.output - prev.output),
                cacheRead: Math.max(0, cumulative.cacheRead - prev.cacheRead),
                cacheWrite: 0,
              }
            : cumulative;
        if (reset) session.usageByModel = {};
        const modelKey = session.model?.id ?? "";
        const bucket = (session.usageByModel[modelKey] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        bucket.input += delta.input;
        bucket.output += delta.output;
        bucket.cacheRead += delta.cacheRead;
        session.usage = cumulative;
        if (event.contextWindow) session.contextWindow = event.contextWindow;
        if (event.contextUsed !== undefined) session.contextUsed = event.contextUsed;
        if (event.limits) {
          const limits = limitsFromCodex(event.limits, when);
          if (limits && (!this.rolloutLimits || limits.updatedAt >= this.rolloutLimits.updatedAt)) {
            this.rolloutLimits = limits;
          }
        }
        if (event.planType) {
          const name = planNameFor(event.planType);
          if (name) this.planName = name;
        }
        break;
      }
      case "agent_close":
        for (const target of event.targets) {
          const sub = this.sessions.get(target.toLowerCase());
          if (sub) sub.ended = true;
        }
        session.status = "working";
        session.action = "Closing an agent";
        break;
    }

    if (session.status === "thinking") {
      if (!wasThinking || session.thinkingStartedAt === undefined) session.thinkingStartedAt = when;
    } else {
      delete session.thinkingStartedAt;
    }

    this.onChange();
  }

  setPlanName(name: string | undefined): void {
    if (name === this.planName) return;
    this.planName = name;
    if (!this.planOverride) this.onChange();
  }

  setResetCreditsAvailable(available: number | undefined): void {
    const next =
      available === undefined || !Number.isFinite(available)
        ? undefined
        : Math.max(0, Math.floor(available));
    if (next === this.resetCreditsAvailable) return;
    this.resetCreditsAvailable = next;
    this.onChange();
  }

  setAccountLimits(limits: Limits | undefined): void {
    this.appServerLimits = limits;
    this.onChange();
  }

  setSessionGoals(remote: boolean, states: ReadonlyMap<string, GoalState>): void {
    const prefix = remote ? "remote:" : "local:";
    const next = new Map<string, GoalState>();
    for (const [sessionId, state] of states) {
      const normalizedId = sessionId.trim().toLowerCase();
      if (normalizedId === "" || !state.active) continue;
      next.set(this.scopedSessionKey(normalizedId, remote), state);
    }

    const current = [...this.sessionGoals].filter(([key]) => key.startsWith(prefix));
    if (current.length === next.size && current.every(([key, state]) => goalStateEquals(state, next.get(key)))) return;
    for (const [key] of current) this.sessionGoals.delete(key);
    for (const [key, state] of next) this.sessionGoals.set(key, state);
    this.onChange();
  }

  setDefaultFastMode(active: boolean): void {
    if (active === this.defaultFastMode) return;
    this.defaultFastMode = active;
    this.onChange();
  }

  setSessionServiceTier(sessionId: string, remote: boolean, serviceTier: string | null): void {
    const normalizedId = sessionId.toLowerCase();
    const key = this.scopedSessionKey(normalizedId, remote);
    if (this.sessionServiceTiers.has(key) && this.sessionServiceTiers.get(key) === serviceTier) return;
    this.sessionServiceTiers.set(key, serviceTier);
    const session = this.sessions.get(normalizedId);
    if (!session || session.remote !== remote) return;
    this.applyServiceTier(session, serviceTier);
    this.onChange();
  }

  setSessionThreadSettings(
    sessionId: string,
    remote: boolean,
    settings: { model?: string; effort?: string | null },
    updatedAt = Date.now(),
  ): void {
    const normalizedId = sessionId.toLowerCase();
    const key = this.scopedSessionKey(normalizedId, remote);
    const current = this.sessionThreadSettings.get(key) ?? {};
    let accepted = false;

    const model = settings.model?.trim();
    if (model && (current.model === undefined || updatedAt >= current.model.updatedAt)) {
      current.model = { value: model, updatedAt };
      accepted = true;
    }
    if (settings.effort !== undefined) {
      const effort = settings.effort === null ? undefined : effortOf(settings.effort.trim().toLowerCase());
      if (
        (settings.effort === null || effort !== undefined) &&
        (current.effort === undefined || updatedAt >= current.effort.updatedAt)
      ) {
        current.effort = { value: effort, updatedAt };
        accepted = true;
      }
    }
    if (!accepted) return;
    this.sessionThreadSettings.set(key, current);

    const session = this.sessions.get(normalizedId);
    if (!session || session.remote !== remote) return;
    if (model) this.applyModel(session, model, updatedAt);
    if (settings.effort !== undefined) this.applyEffort(session, current.effort!.value, updatedAt);
    if (updatedAt > session.lastActivity) session.lastActivity = updatedAt;
    if (updatedAt > session.lastInteractionAt) session.lastInteractionAt = updatedAt;
    this.cleared = false;
    this.onChange();
  }

  setPlanOverride(name: string | undefined): void {
    const value = name && name.trim() !== "" ? name.trim() : undefined;
    if (value === this.planOverride) return;
    this.planOverride = value;
    this.onChange();
  }

  setAppLiveness(alive: boolean, startedAt?: number): void {
    const firstReport = !this.appLivenessKnown;
    this.appLivenessKnown = true;
    if (alive && this.appAlive) {
      if (this.appStartedAt !== undefined || startedAt === undefined) return;
      this.appStartedAt = startedAt;
      this.cleared = false;
      this.onChange();
      return;
    }
    if (!alive && !this.appAlive && !firstReport) return;
    this.appAlive = alive;
    this.appStartedAt = alive ? startedAt : undefined;
    this.cleared = false;
    this.onChange();
  }

  setDesktopSelection(selection: CodexDesktopSelection): void {
    const current = this.desktopSelection;
    if (current?.remote === selection.remote && current.remotePath === selection.remotePath) return;
    this.desktopSelection = selection;
    this.cleared = false;
    this.onChange();
  }

  private hidden(session: CodexSession, now: number): boolean {
    if (this.appAlive) return false;
    const age = now - session.lastActivity;
    if (session.remote) return age > IDLE_MS;
    return this.appLivenessKnown || age > this.appCloseGraceMs;
  }

  private pickActive(): void {
    const now = Date.now();
    let best: string | undefined;
    let bestRank = -1;
    let bestAt = -1;
    let bestSelectionRank = -1;
    for (const session of this.sessions.values()) {
      if (session.isSubagent) continue;
      const selectionRank = this.selectionRank(session);
      if (!this.selectionAllows(session, selectionRank)) continue;
      const stale = now - session.lastActivity > IDLE_MS;
      if (this.hidden(session, now)) continue;
      if (stale && !(this.appAlive && this.desktopSelection && selectionRank > 0)) continue;
      const rank = statusRank(stale ? "idle" : session.status);
      const at = Math.max(session.lastInteractionAt, session.lastActivity);
      if (
        selectionRank > bestSelectionRank ||
        (selectionRank === bestSelectionRank && rank > bestRank) ||
        (selectionRank === bestSelectionRank && rank === bestRank && at > bestAt)
      ) {
        bestSelectionRank = selectionRank;
        bestRank = rank;
        bestAt = at;
        best = session.sessionId;
      }
    }
    if (best === undefined && this.appAlive) {
      let recentAt = -1;
      for (const session of this.sessions.values()) {
        if (session.isSubagent) continue;
        if (!this.selectionAllows(session)) continue;
        const at = Math.max(session.lastInteractionAt, session.lastActivity);
        if (at > recentAt) {
          recentAt = at;
          best = session.sessionId;
        }
      }
    }
    this.activeId = best;
  }

  private selectionRank(session: CodexSession): number {
    const selection = this.desktopSelection;
    if (!selection) return session.remote ? 0 : 1;
    if (session.remote !== selection.remote) return 0;
    if (!selection.remotePath || !session.cwd) return 1;
    const root = normalizePath(selection.remotePath);
    const cwd = normalizePath(session.cwd);
    return cwd === root || cwd.startsWith(`${root}/`) ? 2 : 1;
  }

  private selectionAllows(session: CodexSession, rank = this.selectionRank(session)): boolean {
    const selection = this.desktopSelection;
    if (!selection?.remote) return true;
    return rank >= (selection.remotePath ? 2 : 1);
  }

  private active(): CodexSession | undefined {
    this.pickActive();
    if (!this.activeId) return undefined;
    return this.sessions.get(this.activeId);
  }

  private agentsRunning(parentId: string): number {
    const now = Date.now();
    let count = 0;
    for (const session of this.sessions.values()) {
      if (!session.isSubagent || session.parentThreadId !== parentId) continue;
      if (session.ended) continue;
      if (now - session.lastActivity > AGENT_IDLE_MS) continue;
      count += 1;
    }
    return count;
  }

  private checkIdle(): void {
    const active = this.active();
    if (!active || Date.now() - active.lastActivity > IDLE_MS) {
      if (!this.cleared) {
        this.cleared = true;
        this.onChange();
      } else if (active && (this.appServerLimits ?? this.rolloutLimits)) {
        this.onChange();
      }
      return;
    }
    if (active.status === "thinking" || this.appServerLimits || this.rolloutLimits) this.onChange();
  }

  snapshot(): PresenceState | undefined {
    const active = this.active();
    const now = Date.now();
    if (!active) {
      this.activeSince = undefined;
      return undefined;
    }
    const stale = now - active.lastActivity > IDLE_MS;
    const goal = this.sessionGoals.get(this.scopedSessionKey(active.sessionId, active.remote));
    if (this.appAlive && this.appStartedAt !== undefined) {
      this.activeSince = Math.min(this.appStartedAt, now);
    } else if (this.activeSince === undefined) {
      this.activeSince = Math.min(active.startTimestamp, now);
    }

    const status: SessionStatus = stale ? "idle" : active.status;
    const state: PresenceState = {
      planName: this.planOverride ?? this.planName ?? "",
      action: actionForStatus(status, active.action),
      status,
      planMode: !stale && active.planMode,
      agentsRunning: stale ? 0 : this.agentsRunning(active.sessionId),
      agentsIdle: 0,
      startTimestamp: this.activeSince,
      remote: active.remote,
      realtime: !stale && active.realtime,
      goalActive: goal?.active ?? false,
      goalElapsedSeconds: goal?.elapsedSeconds,
      fastMode: active.fastMode ?? this.defaultFastMode,
    };
    if (!stale && status === "thinking" && active.thinkingStartedAt !== undefined) {
      state.thinkingSeconds = Math.max(0, Math.floor((now - active.thinkingStartedAt) / 1000));
    }
    if (this.resetCreditsAvailable !== undefined) {
      state.resetCreditsAvailable = this.resetCreditsAvailable;
    }
    const monthlyUsage = active.remote ? this.remoteMonthlyUsage : this.localMonthlyUsage;
    if (monthlyUsage) state.monthlyUsage = monthlyUsage;
    if (active.model) state.model = active.model;
    if (active.effort) state.effort = active.effort;
    const accountLimits = this.appServerLimits ?? this.rolloutLimits;
    if (accountLimits) state.limits = mergeLimits(accountLimits, undefined);
    if (active.usage) {
      state.usage = active.usage;
      const models = Object.keys(active.usageByModel);
      const breakdown: { input: number; output: number; cacheRead: number; total: number } = {
        input: 0,
        output: 0,
        cacheRead: 0,
        total: 0,
      };
      if (models.length > 0) {
        for (const model of models) {
          const usage = active.usageByModel[model]!;
          const cost = codexCost(model === "" ? undefined : model, {
            input: usage.input,
            cachedInput: usage.cacheRead,
            output: usage.output,
          });
          breakdown.input += cost.input;
          breakdown.output += cost.output;
          breakdown.cacheRead += cost.cached;
          breakdown.total += cost.total;
        }
      } else {
        const cost = codexCost(active.model?.id, {
          input: active.usage.input,
          cachedInput: active.usage.cacheRead,
          output: active.usage.output,
        });
        breakdown.input = cost.input;
        breakdown.output = cost.output;
        breakdown.cacheRead = cost.cached;
        breakdown.total = cost.total;
      }
      state.costUsd = breakdown.total;
      state.costBreakdown = {
        input: breakdown.input,
        output: breakdown.output,
        cacheRead: breakdown.cacheRead,
        cacheWrite: 0,
        total: breakdown.total,
      };
    }
    if (active.contextUsed !== undefined && active.contextWindow && active.contextWindow > 0) {
      state.contextPct = Math.max(0, Math.min(100, (active.contextUsed / active.contextWindow) * 100));
    }
    return state;
  }
}
