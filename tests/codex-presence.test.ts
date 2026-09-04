import { test, expect } from "vitest";
import { codexModelDisplayName, buildCodexActivity } from "../src/codex/presence.ts";
import type { PresenceState } from "../src/types.ts";

const assets = { appName: "Codex", largeImageKey: "codex-color" };

function base(): PresenceState {
  return {
    planName: "Pro",
    action: "Editing config.ts",
    status: "working",
    planMode: false,
    agentsRunning: 0,
    agentsIdle: 0,
  };
}

test("model display names", () => {
  expect(codexModelDisplayName("gpt-6-astra")).toBe("GPT-6 Astra");
  expect(codexModelDisplayName(" GPT-6-ASTRA-2026-09-03-fast ")).toBe("GPT-6 Astra");
  expect(codexModelDisplayName("gpt-5.5")).toBe("GPT-5.5");
  expect(codexModelDisplayName("gpt-5.4-mini")).toBe("GPT-5.4 Mini");
  expect(codexModelDisplayName("gpt-5-codex")).toBe("GPT-5 Codex");
  expect(codexModelDisplayName("gpt-6.1-nano")).toBe("GPT-6.1 Nano");
  expect(codexModelDisplayName(undefined)).toBe("Codex");
});

test("gpt-5.6 family display names", () => {
  expect(codexModelDisplayName("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
  expect(codexModelDisplayName("gpt-5.6-terra")).toBe("GPT-5.6 Terra");
  expect(codexModelDisplayName("gpt-5.6-luna")).toBe("GPT-5.6 Luna");
  expect(codexModelDisplayName("gpt-5.6")).toBe("GPT-5.6");
  expect(codexModelDisplayName("gpt-5.7-terra")).toBe("GPT-5.7 Terra");
});

test("details line shows plan and limits", () => {
  const state = base();
  state.limits = { updatedAt: 0, fiveHour: { usedPercentage: 2 }, sevenDay: { usedPercentage: 9 } };
  const activity = buildCodexActivity(state, assets);
  expect(activity.details).toBe("Pro • 5h 98% left • 7d 91% left");
});

test("details line keeps monthly usage only on the small icon", () => {
  const state = base();
  state.monthlyUsage = { costUsd: 410.189, totalTokens: 641_574_830 };
  expect(buildCodexActivity(state, assets).details).toBe("Pro");
});

test("monthly usage is shown when hovering the small statistics icon", () => {
  const state = base();
  state.monthlyUsage = {
    costUsd: 410.189,
    totalTokens: 641_574_830,
    day: { costUsd: 12.34, totalTokens: 20_000_000 },
    week: { costUsd: 80, totalTokens: 100_000_000 },
    allTime: { costUsd: 999.99, totalTokens: 2_000_000_000 },
  };
  const activity = buildCodexActivity(state, { ...assets, smallImageKey: "usage-stats" });
  expect(activity.smallImageKey).toBe("usage-stats");
  expect(activity.smallImageText).toBe(
    "Day\u00a0$12.3·20M\u00a0tok\nWeek\u00a0$80·100M\u00a0tok\nMonth\u00a0$410·641.6M\u00a0tok\nTotal\u00a0$1K·2B\u00a0tok",
  );
});

test("details line shows independent available reset credits", () => {
  const state = base();
  state.resetCreditsAvailable = 5;
  state.limits = { updatedAt: 0, fiveHour: { usedPercentage: 2 }, sevenDay: { usedPercentage: 9 } };
  const activity = buildCodexActivity(state, assets);
  expect(activity.details).toBe("Pro • 5 resets left • 5h 98% left • 7d 91% left");
});

test("details line uses the singular reset label", () => {
  const state = base();
  state.resetCreditsAvailable = 1;
  expect(buildCodexActivity(state, assets).details).toBe("Pro • 1 reset left");
});

test("details line omits unavailable independent reset credits", () => {
  const state = base();
  state.resetCreditsAvailable = 0;
  expect(buildCodexActivity(state, assets).details).toBe("Pro");
});

test("details line shows when the 5h and 7d limits reset", () => {
  const now = Date.now();
  const state = base();
  state.limits = {
    updatedAt: now,
    fiveHour: { usedPercentage: 11, resetsAt: now + 2 * 60 * 60 * 1000 },
    sevenDay: { usedPercentage: 2, resetsAt: now + (6 * 24 + 7) * 60 * 60 * 1000 },
  };
  const activity = buildCodexActivity(state, assets);
  expect(activity.details).toBe(
    "Pro • 5h 89% left (resets in 2h) • 7d 98% left (resets in 6d 7h)",
  );
});

test("details line omits the plan segment when the plan is unknown", () => {
  const state = base();
  state.planName = "";
  state.limits = { updatedAt: 0, fiveHour: { usedPercentage: 2 }, sevenDay: { usedPercentage: 9 } };
  const activity = buildCodexActivity(state, assets);
  expect(activity.details).toBe("5h 98% left • 7d 91% left");
});

test("state line shows model, effort, action", () => {
  const state = base();
  state.model = { id: "gpt-5.5", displayName: "GPT-5.5" };
  state.effort = "xhigh";
  const activity = buildCodexActivity(state, assets);
  expect(activity.state).toBe("GPT-5.5 (Extra High) • Editing config.ts");
});

test("Thinking shows its elapsed time in seconds", () => {
  const state = base();
  state.status = "thinking";
  state.action = "Thinking";
  state.thinkingSeconds = 42;
  expect(buildCodexActivity(state, assets).state).toContain("Thinking (42s)");
});

test("remote and agents chips appear in the tail", () => {
  const state = base();
  state.model = { id: "gpt-5.5", displayName: "GPT-5.5" };
  state.agentsRunning = 3;
  state.remote = true;
  const activity = buildCodexActivity(state, assets);
  expect(activity.state).toContain("3 agents running");
  expect(activity.state).toContain("Remote");
});

test("Fast is appended to the model while the goal remains in the tail", () => {
  const state = base();
  state.model = { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" };
  state.effort = "xhigh";
  state.goalActive = true;
  state.goalElapsedSeconds = 3_665;
  state.fastMode = true;
  const activity = buildCodexActivity(state, assets);
  expect(activity.state).toBe(
    "GPT-5.6 Sol (Extra High) Fast • Editing config.ts • Goal active (1h 1m)",
  );
  expect(activity.state).not.toContain("Fast mode");
});

test("omitting custom art lets Discord use the application icon", () => {
  const activity = buildCodexActivity(base(), { appName: "Codex" });
  expect(activity.largeImageKey).toBeUndefined();
  expect(activity.largeImageUrl).toBeUndefined();
  expect(activity.largeImageText).toBeUndefined();
});

test("adds the configured repository button", () => {
  const activity = buildCodexActivity(base(), {
    appName: "Codex",
    buttons: [{ label: "Get Codex Presence", url: "https://github.com/example/codex" }],
  });
  expect(activity.buttons).toEqual([
    { label: "Get Codex Presence", url: "https://github.com/example/codex" },
  ]);
});

test("hover shows tokens and context", () => {
  const state = base();
  state.usage = { input: 12378, output: 178, cacheRead: 5504, cacheWrite: 0 };
  state.contextPct = 4.86;
  const activity = buildCodexActivity(state, assets);
  expect(activity.largeImageText).toBe("In 12.4K • Cached 5.5K • Out 178 • Ctx 5%");
});

test("hover includes cost when present", () => {
  const state = base();
  state.usage = { input: 1_000_000, output: 100_000, cacheRead: 200_000, cacheWrite: 0 };
  state.costUsd = 7.1;
  state.contextPct = 20;
  const activity = buildCodexActivity(state, assets);
  expect(activity.largeImageText).toBe("In 1M • Cached 200K • Out 100K • $7.10 • Ctx 20%");
});

test("hover without usage falls back to app name", () => {
  const activity = buildCodexActivity(base(), assets);
  expect(activity.largeImageText).toBe("Codex");
});

test("small statistics tooltip uses the compact Light-era labels", () => {
  const state = base();
  state.model = { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" };
  state.effort = "low";
  state.monthlyUsage = {
    costUsd: 654.31,
    totalTokens: 677_900_000,
    day: { costUsd: 1.54, totalTokens: 1_000_000 },
    week: { costUsd: 230.69, totalTokens: 275_400_000 },
    allTime: { costUsd: 1_190, totalTokens: 1_100_000_000 },
  };
  const activity = buildCodexActivity(state, { ...assets, smallImageKey: "usage-stats" });
  expect(activity.state).toBe("GPT-5.6 Sol (Light) • Editing config.ts");
  expect(activity.smallImageText).toBe(
    "Day\u00a0$1.54·1M\u00a0tok\nWeek\u00a0$231·275.4M\u00a0tok\nMonth\u00a0$654·677.9M\u00a0tok\nTotal\u00a0$1.19K·1.1B\u00a0tok",
  );
  expect(activity.smallImageText!.split("\n").every((line) => !line.includes(" "))).toBe(true);
  expect(Math.max(...activity.smallImageText!.split("\n").map((line) => line.length))).toBeLessThanOrEqual(24);
  expect(new TextEncoder().encode(activity.smallImageText!).length).toBeLessThanOrEqual(128);
});
