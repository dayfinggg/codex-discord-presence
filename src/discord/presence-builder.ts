import type { EffortLevel, PresenceState } from "../types.ts";

export interface Activity {
  type: number;
  name?: string;
  details: string;
  state: string;
  largeImageKey?: string;
  largeImageUrl?: string;
  largeImageText?: string;
  smallImageKey?: string;
  smallImageUrl?: string;
  smallImageText?: string;
  startTimestamp?: number;
  endTimestamp?: number;
}

export interface ActivityAssets {
  appName: string;
  largeImageKey?: string;
  largeImageUrl?: string;
  smallImageKey?: string;
  smallImageUrl?: string;
}

export interface DetailsOptions {
  showResetCountdowns?: boolean;
  now?: number;
}

const MIN = 2;
const MAX = 128;
const SEP = " • ";

const EFFORT_LABELS: Record<EffortLevel, string> = {
  minimal: "Minimal",
  low: "Light",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

function pctLeft(usedPercentage: number): number {
  const left = Math.round(100 - usedPercentage);
  return Math.max(0, Math.min(100, left));
}

function formatGoalDuration(elapsedSeconds?: number): string {
  const totalMinutes = Math.max(0, Math.floor((elapsedSeconds ?? 0) / 60));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function goalChip(state: PresenceState): string | undefined {
  return state.goalActive ? `Goal active (${formatGoalDuration(state.goalElapsedSeconds)})` : undefined;
}

export function clamp(text: string): string {
  let out = text;
  if (byteLength(out) > MAX) out = fitBytes(out, MAX, true);
  if (out.length < MIN) out = (out + "  ").slice(0, MIN);
  return out;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function fitBytes(text: string, maxBytes: number, ellipsis: boolean): string {
  const suffix = ellipsis ? "…" : "";
  const suffixBytes = byteLength(suffix);
  if (maxBytes <= suffixBytes) return suffix.slice(0, maxBytes);
  let fitted = text;
  while (fitted !== "" && byteLength(fitted) + suffixBytes > maxBytes) fitted = fitted.slice(0, -1);
  return fitted.trimEnd() + suffix;
}

export function formatResetCountdown(resetsAt: number | undefined, now = Date.now()): string | undefined {
  if (resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt <= now) return undefined;
  const totalMinutes = Math.max(1, Math.ceil((resetsAt - now) / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d${hours > 0 ? ` ${hours}h` : ""}`;
  if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
  return `${minutes}m`;
}

function limitText(
  label: string,
  usedPercentage: number,
  resetsAt: number | undefined,
  options: DetailsOptions,
): string {
  let text = `${label} ${pctLeft(usedPercentage)}% left`;
  if (!options.showResetCountdowns) return text;
  const countdown = formatResetCountdown(resetsAt, options.now);
  if (countdown) text += ` (resets in ${countdown})`;
  return text;
}

export function buildDetails(state: PresenceState, options: DetailsOptions = {}): string {
  const segments: string[] = [];
  if (state.planName.trim() !== "") segments.push(state.planName);
  if (state.resetCreditsAvailable !== undefined && state.resetCreditsAvailable > 0) {
    const noun = state.resetCreditsAvailable === 1 ? "reset" : "resets";
    segments.push(`${state.resetCreditsAvailable} ${noun} left`);
  }
  const five = state.limits?.fiveHour;
  const seven = state.limits?.sevenDay;
  const scopedText = state.limits?.sevenDayScoped
    ?.map((limit) => `${limit.label} ${pctLeft(limit.usedPercentage)}% left`)
    .join(", ");
  if (five) segments.push(limitText("5h", five.usedPercentage, five.resetsAt, options));
  if (seven) {
    segments.push(
      `${limitText("7d", seven.usedPercentage, seven.resetsAt, options)}${scopedText ? ` (${scopedText})` : ""}`,
    );
  } else if (scopedText) {
    segments.push(`7d ${scopedText}`);
  }
  return clamp(segments.join(SEP));
}

function tailChips(state: PresenceState): string {
  const chips: string[] = [];
  const goal = goalChip(state);
  if (goal) chips.push(goal);
  if (state.planMode) chips.push("Plan mode");
  if (state.agentsRunning > 0) {
    const noun = state.agentsRunning === 1 ? "agent" : "agents";
    let chip = `${state.agentsRunning} ${noun} running`;
    if (state.agentsIdle > 0) chip += ` (${state.agentsIdle} idle)`;
    chips.push(chip);
  }
  if (state.realtime) chips.push("Realtime");
  if (state.remote) chips.push("Remote");
  return chips.join(SEP);
}

function requiredTailChips(state: PresenceState): string {
  const chips: string[] = [];
  const goal = goalChip(state);
  if (goal) chips.push(goal);
  return chips.join(SEP);
}

export function buildStateLine(state: PresenceState): string {
  const effort = state.effort ? ` (${EFFORT_LABELS[state.effort]})` : "";
  const fast = state.fastMode ? " Fast" : "";
  const head = state.model ? `${state.model.displayName}${effort}${fast}` : state.fastMode ? "Fast" : "";
  const action = state.status === "thinking" && state.thinkingSeconds !== undefined
    ? `Thinking (${Math.max(0, Math.floor(state.thinkingSeconds))}s)`
    : state.action.trim();
  const tail = tailChips(state);
  const priority = [head, action, tail].filter((segment) => segment !== "");
  if (priority.length === 0) return clamp("Codex");

  const line = priority.join(SEP);
  if (byteLength(line) <= MAX) return clamp(line);

  const requiredTail = requiredTailChips(state);
  if (requiredTail !== "") {
    const fixedLength = byteLength([head, requiredTail].filter((segment) => segment !== "").join(SEP));
    const actionBudget = MAX - fixedLength - (action !== "" ? byteLength(SEP) : 0);
    const fittedAction =
      actionBudget <= 0
        ? ""
        : byteLength(action) > actionBudget
          ? fitBytes(action, actionBudget, true)
          : action;
    return clamp([head, fittedAction, requiredTail].filter((segment) => segment !== "").join(SEP));
  }

  const headOnly = head !== "" ? head : action;
  const withAction = [head, action].filter((segment) => segment !== "").join(SEP);
  return clamp(byteLength(withAction) <= MAX ? withAction : headOnly);
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000_000_000) return `${(tokens / 1_000_000_000_000).toFixed(1).replace(/\.0$/, "")}T`;
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(Math.round(tokens));
}

export function formatCost(usd: number): string {
  if (usd >= 0.1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

export function formatMonthlyUsage(state: PresenceState): string | undefined {
  const monthly = state.monthlyUsage;
  if (!monthly || (monthly.totalTokens <= 0 && monthly.costUsd <= 0)) return undefined;
  if (!monthly.day || !monthly.week || !monthly.allTime) {
    return `Month\u00a0$${formatMonthlyCost(monthly.costUsd)}·${formatTokens(monthly.totalTokens)}\u00a0tok`;
  }
  const period = (label: string, usage: { costUsd: number; totalTokens: number }) =>
    `${label}\u00a0$${formatMonthlyCost(usage.costUsd)}·${formatTokens(usage.totalTokens)}\u00a0tok`;
  return clamp([
    period("Day", monthly.day),
    period("Week", monthly.week),
    period("Month", monthly),
    period("Total", monthly.allTime),
  ].join("\n"));
}

function formatMonthlyCost(costUsd: number): string {
  if (costUsd < 10) return costUsd.toFixed(2);
  if (costUsd < 100) return costUsd.toFixed(1).replace(/\.0$/, "");
  if (Math.round(costUsd) < 1_000) return String(Math.round(costUsd));
  return `${(costUsd / 1_000).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}K`;
}

export function activityEquals(a: Activity | undefined, b: Activity | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.name === b.name &&
    a.details === b.details &&
    a.state === b.state &&
    a.largeImageKey === b.largeImageKey &&
    a.largeImageUrl === b.largeImageUrl &&
    a.largeImageText === b.largeImageText &&
    a.smallImageKey === b.smallImageKey &&
    a.smallImageUrl === b.smallImageUrl &&
    a.smallImageText === b.smallImageText &&
    a.startTimestamp === b.startTimestamp &&
    a.endTimestamp === b.endTimestamp
  );
}
