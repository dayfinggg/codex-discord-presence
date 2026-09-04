import type { PresenceState } from "../types.ts";
import type { Activity, ActivityAssets } from "../discord/presence-builder.ts";
import {
  buildDetails,
  buildStateLine,
  clamp,
  formatTokens,
  formatCost,
  formatMonthlyUsage,
} from "../discord/presence-builder.ts";

const MODEL_NAMES: Record<string, string> = {
  "gpt-6-astra": "GPT-6 Astra",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "gpt-5.6": "GPT-5.6",
  "gpt-5.5": "GPT-5.5",
  "gpt-5.5-codex": "GPT-5.5 Codex",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gpt-5.4-codex": "GPT-5.4 Codex",
  "gpt-5": "GPT-5",
  "gpt-5-codex": "GPT-5 Codex",
};

const WORD_CASE: Record<string, string> = {
  astra: "Astra",
  spark: "Spark",
  max: "Max",
  mini: "Mini",
  nano: "Nano",
  codex: "Codex",
  pro: "Pro",
  sol: "Sol",
  terra: "Terra",
  luna: "Luna",
};

export function codexModelDisplayName(id?: string): string {
  if (!id || id.trim() === "") return "Codex";
  const key = id.trim().toLowerCase().replace(/-fast$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
  if (MODEL_NAMES[key]) return MODEL_NAMES[key]!;
  if (key.startsWith("gpt-")) {
    const rest = key.slice(4).split("-");
    const version = rest.shift() ?? "";
    const suffix = rest.map((word) => WORD_CASE[word] ?? word).join(" ");
    return `GPT-${version}${suffix ? ` ${suffix}` : ""}`;
  }
  return id;
}

function buildHover(state: PresenceState, appName: string): string {
  const usage = state.usage;
  if (!usage) return appName;
  const parts = [`In ${formatTokens(usage.input)}`];
  if (usage.cacheRead > 0) parts.push(`Cached ${formatTokens(usage.cacheRead)}`);
  parts.push(`Out ${formatTokens(usage.output)}`);
  if (state.costUsd !== undefined && state.costUsd > 0) parts.push(formatCost(state.costUsd));
  if (state.contextPct !== undefined) parts.push(`Ctx ${Math.round(state.contextPct)}%`);
  return parts.join(" • ");
}

export function buildCodexActivity(state: PresenceState, assets: ActivityAssets): Activity {
  const activity: Activity = {
    type: 0,
    name: assets.appName,
    details: buildDetails(state, { showResetCountdowns: true }),
    state: buildStateLine(state),
  };
  const hover = clamp(buildHover(state, assets.appName));
  if (assets.largeImageKey) {
    activity.largeImageKey = assets.largeImageKey;
    activity.largeImageText = hover;
  } else if (assets.largeImageUrl) {
    activity.largeImageUrl = assets.largeImageUrl;
    activity.largeImageText = hover;
  }
  const monthlyHover = formatMonthlyUsage(state);
  if (monthlyHover && assets.smallImageKey) {
    activity.smallImageKey = assets.smallImageKey;
    activity.smallImageText = monthlyHover;
  } else if (monthlyHover && assets.smallImageUrl) {
    activity.smallImageUrl = assets.smallImageUrl;
    activity.smallImageText = monthlyHover;
  }
  if (state.startTimestamp) activity.startTimestamp = state.startTimestamp;
  if (assets.buttons?.length) activity.buttons = assets.buttons;
  return activity;
}
