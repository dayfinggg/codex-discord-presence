import { test, expect } from "vitest";
import { CodexStore } from "../src/codex/codex-store.ts";
import type { CodexEvent } from "../src/codex/rollout-parser.ts";

const PARENT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

function feed(store: CodexStore, sessionId: string, events: CodexEvent[], remote = false): void {
  for (const event of events) store.handleEvent(sessionId, remote, event);
}

test("a user turn produces a working snapshot with model, plan and limits", () => {
  const store = new CodexStore(() => {});
  feed(store, PARENT, [
    { kind: "session_meta", isSubagent: false },
    { kind: "turn_context", model: "gpt-5.5", effort: "xhigh", planMode: false, realtime: false },
    { kind: "user_message" },
    { kind: "tool", name: "apply_patch", file: "config.ts" },
    {
      kind: "token_count",
      usage: { input: 12378, cachedInput: 5504, output: 178, reasoning: 171, total: 12556 },
      contextWindow: 258400,
      contextUsed: 12556,
      limits: {
        primary: { usedPercent: 2, windowMinutes: 300, resetsAt: 1783521774 },
        secondary: { usedPercent: 9, windowMinutes: 10080 },
      },
      planType: "pro",
    },
  ]);

  const snap = store.snapshot();
  expect(snap).toBeDefined();
  expect(snap!.status).toBe("working");
  expect(snap!.action).toBe("Editing config.ts");
  expect(snap!.model).toEqual({ id: "gpt-5.5", displayName: "GPT-5.5" });
  expect(snap!.effort).toBe("xhigh");
  expect(snap!.planName).toBe("Pro 20X");
  expect(snap!.limits?.fiveHour?.usedPercentage).toBe(2);
  expect(snap!.limits?.sevenDay?.usedPercentage).toBe(9);
  expect(snap!.usage).toEqual({ input: 12378, output: 178, cacheRead: 5504, cacheWrite: 0 });
  expect(Math.round(snap!.contextPct!)).toBe(5);
  expect(snap!.costUsd).toBeGreaterThan(0);
  expect(snap!.costBreakdown?.cacheRead).toBeCloseTo((5504 / 1_000_000) * 0.5, 6);
});

test("authoritative app-server limits override model-specific rollout limits", () => {
  const store = new CodexStore(() => {});
  feed(store, PARENT, [
    { kind: "session_meta", isSubagent: false },
    { kind: "user_message" },
    {
      kind: "token_count",
      usage: { input: 100, cachedInput: 0, output: 10, reasoning: 0, total: 110 },
      limits: { primary: { usedPercent: 0, windowMinutes: 10_080 } },
    },
  ]);

  store.setAccountLimits({ sevenDay: { usedPercentage: 3 }, updatedAt: Date.now() });

  expect(store.snapshot()!.limits?.sevenDay?.usedPercentage).toBe(3);
});

test("goal state propagates to the Codex snapshot", () => {
  const store = new CodexStore(() => {});
  feed(store, PARENT, [{ kind: "session_meta", isSubagent: false }, { kind: "user_message" }]);
  store.setSessionGoals(false, new Map([[PARENT, { active: true, elapsedSeconds: 3_665 }]]));
  expect(store.snapshot()!.goalActive).toBe(true);
  expect(store.snapshot()!.goalElapsedSeconds).toBe(3_665);
  store.dispose();
});

test("a goal from another session is hidden until that session becomes active", () => {
  const store = new CodexStore(() => {});
  const now = Date.now();
  store.handleEvent(PARENT, false, { kind: "session_meta", isSubagent: false }, now - 2_000);
  store.handleEvent(PARENT, false, { kind: "user_message" }, now - 1_900);
  store.handleEvent(OTHER, false, { kind: "session_meta", isSubagent: false }, now - 1_000);
  store.handleEvent(OTHER, false, { kind: "user_message" }, now - 900);
  store.setSessionGoals(false, new Map([[PARENT, { active: true, elapsedSeconds: 125 }]]));

  expect(store.snapshot()!.goalActive).toBe(false);

  store.handleEvent(PARENT, false, { kind: "user_message" }, now);
  expect(store.snapshot()!.goalActive).toBe(true);
  expect(store.snapshot()!.goalElapsedSeconds).toBe(125);
  store.dispose();
});

test("a spurious all-zero rate-limit snapshot does not clobber real limits", () => {
  const store = new CodexStore(() => {});
  feed(store, PARENT, [
    { kind: "session_meta", isSubagent: false },
    { kind: "turn_context", model: "gpt-5.5", effort: "high", planMode: false, realtime: false },
    { kind: "user_message" },
    {
      kind: "token_count",
      usage: { input: 100, cachedInput: 0, output: 10, reasoning: 0, total: 110 },
      limits: {
        primary: { usedPercent: 2, windowMinutes: 300, resetsAt: 1783557859 },
        secondary: { usedPercent: 11, windowMinutes: 10080, resetsAt: 1784000170 },
      },
      planType: "pro",
    },
    {
      kind: "token_count",
      usage: { input: 120, cachedInput: 0, output: 12, reasoning: 0, total: 132 },
      limits: {
        primary: { usedPercent: 0, windowMinutes: 300, resetsAt: 1783565144 },
        secondary: { usedPercent: 0, windowMinutes: 10080, resetsAt: 1784104015 },
      },
      planType: "pro",
    },
  ]);

  const snap = store.snapshot();
  expect(snap!.limits?.fiveHour?.usedPercentage).toBe(2);
  expect(snap!.limits?.sevenDay?.usedPercentage).toBe(11);
});

test("a real zero on one window is preserved when the other is active", () => {
  const store = new CodexStore(() => {});
  feed(store, PARENT, [
    { kind: "session_meta", isSubagent: false },
    { kind: "user_message" },
    {
      kind: "token_count",
      usage: { input: 100, cachedInput: 0, output: 10, reasoning: 0, total: 110 },
      limits: {
        primary: { usedPercent: 0, windowMinutes: 300, resetsAt: 1783557859 },
        secondary: { usedPercent: 23, windowMinutes: 10080, resetsAt: 1784000170 },
      },
    },
  ]);

  const snap = store.snapshot();
  expect(snap!.limits?.fiveHour?.usedPercentage).toBe(0);
  expect(snap!.limits?.sevenDay?.usedPercentage).toBe(23);
});

test("slightly shortened rolling windows retain their 5h and 7d meaning", () => {
  const store = new CodexStore(() => {});
  feed(store, PARENT, [
    { kind: "session_meta", isSubagent: false },
    { kind: "user_message" },
    {
      kind: "token_count",
      usage: { input: 100, cachedInput: 0, output: 10, reasoning: 0, total: 110 },
      limits: {
        primary: { usedPercent: 12, windowMinutes: 299 },
        secondary: { usedPercent: 34, windowMinutes: 10_079 },
      },
    },
  ]);

  expect(store.snapshot()!.limits).toMatchObject({
    fiveHour: { usedPercentage: 12 },
    sevenDay: { usedPercentage: 34 },
  });
});

test("a weekly-only primary window is not exposed as a five-hour limit", () => {
  const store = new CodexStore(() => {});
  feed(store, PARENT, [
    { kind: "session_meta", isSubagent: false },
    { kind: "user_message" },
    {
      kind: "token_count",
      usage: { input: 100, cachedInput: 0, output: 10, reasoning: 0, total: 110 },
      limits: {
        primary: { usedPercent: 13, windowMinutes: 10080, resetsAt: 1784000170 },
      },
    },
  ]);

  const snap = store.snapshot();
  expect(snap!.limits?.fiveHour).toBeUndefined();
  expect(snap!.limits?.sevenDay?.usedPercentage).toBe(13);
});

test("a newer weekly-only snapshot removes a previously available five-hour limit", () => {
  const store = new CodexStore(() => {});
  const now = Date.now();
  store.handleEvent(PARENT, false, { kind: "session_meta", isSubagent: false }, now - 2000);
  store.handleEvent(PARENT, false, { kind: "user_message" }, now - 2000);
  store.handleEvent(
    PARENT,
    false,
    {
      kind: "token_count",
      usage: { input: 100, cachedInput: 0, output: 10, reasoning: 0, total: 110 },
      limits: {
        primary: { usedPercent: 2, windowMinutes: 300 },
        secondary: { usedPercent: 9, windowMinutes: 10080 },
      },
    },
    now - 1000,
  );
  store.handleEvent(
    PARENT,
    false,
    {
      kind: "token_count",
      usage: { input: 120, cachedInput: 0, output: 12, reasoning: 0, total: 132 },
      limits: {
        primary: { usedPercent: 13, windowMinutes: 10080 },
      },
    },
    now,
  );

  const snap = store.snapshot();
  expect(snap!.limits?.fiveHour).toBeUndefined();
  expect(snap!.limits?.sevenDay?.usedPercentage).toBe(13);
});

test("turn end moves the session to idle", () => {
  const store = new CodexStore(() => {});
  feed(store, PARENT, [
    { kind: "session_meta", isSubagent: false },
    { kind: "user_message" },
    { kind: "turn_ended" },
  ]);
  const snap = store.snapshot();
  expect(snap!.status).toBe("idle");
  expect(snap!.action).toBe("Idle");
});

test("a plan override wins over the detected plan", () => {
  const store = new CodexStore(() => {});
  store.setPlanName("Pro");
  store.setPlanOverride("Pro 20X");
  feed(store, PARENT, [
    { kind: "session_meta", isSubagent: false },
    { kind: "user_message" },
    {
      kind: "token_count",
      usage: { input: 1, cachedInput: 0, output: 1, reasoning: 0, total: 2 },
      planType: "pro",
    },
  ]);
  expect(store.snapshot()!.planName).toBe("Pro 20X");
});

test("plan mode is reflected", () => {
  const store = new CodexStore(() => {});
  feed(store, PARENT, [
    { kind: "session_meta", isSubagent: false },
    { kind: "turn_context", model: "gpt-5.5", planMode: true, realtime: false },
    { kind: "user_message" },
  ]);
  expect(store.snapshot()!.planMode).toBe(true);
});

test("running subagents are counted for the parent", () => {
  const store = new CodexStore(() => {});
  feed(store, PARENT, [
    { kind: "session_meta", isSubagent: false },
    { kind: "user_message" },
    { kind: "tool", name: "spawn_agent" },
  ]);
  feed(store, CHILD, [
    { kind: "session_meta", isSubagent: true, parentThreadId: PARENT },
    { kind: "tool", name: "shell_command" },
  ]);

  const active = store.snapshot();
  expect(active!.agentsRunning).toBe(1);

  store.handleEvent(CHILD, false, { kind: "turn_ended" });
  expect(store.snapshot()!.agentsRunning).toBe(0);
});

test("close_agent ends a tracked subagent", () => {
  const store = new CodexStore(() => {});
  feed(store, PARENT, [
    { kind: "session_meta", isSubagent: false },
    { kind: "user_message" },
  ]);
  feed(store, CHILD, [{ kind: "session_meta", isSubagent: true, parentThreadId: PARENT }]);
  expect(store.snapshot()!.agentsRunning).toBe(1);

  store.handleEvent(PARENT, false, { kind: "agent_close", targets: [CHILD] });
  expect(store.snapshot()!.agentsRunning).toBe(0);
  expect(store.snapshot()!.action).toBe("Closing an agent");
});

test("remote flag propagates to the snapshot", () => {
  const store = new CodexStore(() => {});
  feed(
    store,
    PARENT,
    [
      { kind: "session_meta", isSubagent: false },
      { kind: "user_message" },
    ],
    true,
  );
  expect(store.snapshot()!.remote).toBe(true);
});

test("a local active session wins over a newer remote active session", () => {
  const store = new CodexStore(() => {});
  const now = Date.now();
  store.handleEvent(PARENT, false, { kind: "session_meta", isSubagent: false }, now - 5000);
  store.handleEvent(PARENT, false, { kind: "tool", name: "shell_command" }, now - 4000);
  store.handleEvent(CHILD, true, { kind: "session_meta", isSubagent: false }, now - 2000);
  store.handleEvent(CHILD, true, { kind: "tool", name: "apply_patch", file: "remote.ts" }, now - 1000);

  const snap = store.snapshot();
  expect(snap!.remote).toBe(false);
  expect(snap!.action).toBe("Running a command");
});

test("a remote active session wins over an idle local session", () => {
  const store = new CodexStore(() => {});
  const now = Date.now();
  store.handleEvent(PARENT, false, { kind: "session_meta", isSubagent: false }, now - 5000);
  store.handleEvent(PARENT, false, { kind: "turn_ended" }, now - 4000);
  store.handleEvent(CHILD, true, { kind: "session_meta", isSubagent: false }, now - 2000);
  store.handleEvent(CHILD, true, { kind: "tool", name: "shell_command" }, now - 1000);
  store.setDesktopSelection({ remote: false });

  const snap = store.snapshot();
  expect(snap!.remote).toBe(true);
  expect(snap!.action).toBe("Running a command");
});

test("desktop selection switches presence between local and remote sessions", () => {
  const store = new CodexStore(() => {});
  const now = Date.now();
  store.handleEvent(PARENT, false, { kind: "session_meta", cwd: "D:\\local", isSubagent: false }, now - 5000);
  store.handleEvent(PARENT, false, { kind: "tool", name: "shell_command" }, now - 4000);
  store.handleEvent(CHILD, true, { kind: "session_meta", cwd: "/srv/app", isSubagent: false }, now - 3000);
  store.handleEvent(CHILD, true, { kind: "turn_ended" }, now - 2000);

  store.setDesktopSelection({ remote: true, remotePath: "/srv/app" });
  expect(store.snapshot()!.remote).toBe(true);
  expect(store.snapshot()!.status).toBe("idle");

  store.setDesktopSelection({ remote: false });
  expect(store.snapshot()!.remote).toBe(false);
  expect(store.snapshot()!.status).toBe("working");
});

test("an ordinary Desktop chat stays visible without a selected project", () => {
  const store = new CodexStore(() => {});
  const now = Date.now();
  store.setAppLiveness(true, now - 60_000);
  store.handleEvent(PARENT, false, { kind: "session_meta", isSubagent: false }, now - 2_000);
  store.handleEvent(PARENT, false, { kind: "user_message" }, now - 1_000);
  expect(store.snapshot()).toMatchObject({ remote: false, status: "thinking" });
  store.dispose();
});

test("a remote selection does not fall back to unrelated local activity", () => {
  const store = new CodexStore(() => {});
  const now = Date.now();
  store.handleEvent(PARENT, false, { kind: "session_meta", cwd: "D:\\local", isSubagent: false }, now - 1_000);
  store.handleEvent(PARENT, false, { kind: "tool", name: "shell_command" }, now - 500);
  store.setAppLiveness(true, now - 5_000);

  store.setDesktopSelection({ remote: true, remotePath: "/srv/not-watched" });
  expect(store.snapshot()).toBeUndefined();
  store.dispose();
});

test("selected remote project wins over another remote project", () => {
  const store = new CodexStore(() => {});
  const now = Date.now();
  store.handleEvent(PARENT, true, { kind: "session_meta", cwd: "/srv/selected/api", isSubagent: false }, now - 5000);
  store.handleEvent(PARENT, true, { kind: "turn_ended" }, now - 4000);
  store.handleEvent(CHILD, true, { kind: "session_meta", cwd: "/srv/other", isSubagent: false }, now - 2000);
  store.handleEvent(CHILD, true, { kind: "tool", name: "shell_command" }, now - 1000);

  store.setDesktopSelection({ remote: true, remotePath: "/srv/selected" });
  expect(store.snapshot()!.action).toBe("Idle");
});

test("a selected remote project does not fall back to a different remote project", () => {
  const store = new CodexStore(() => {});
  const now = Date.now();
  store.handleEvent(PARENT, true, { kind: "session_meta", cwd: "/srv/other", isSubagent: false }, now - 1_000);
  store.handleEvent(PARENT, true, { kind: "tool", name: "shell_command" }, now - 500);

  store.setDesktopSelection({ remote: true, remotePath: "/srv/selected" });
  expect(store.snapshot()).toBeUndefined();
  store.dispose();
});

test("a selected stale project remains visible as idle while Codex is open", () => {
  const store = new CodexStore(() => {});
  const now = Date.now();
  const old = now - 20 * 60 * 1000;
  store.handleEvent(PARENT, true, { kind: "session_meta", cwd: "/srv/selected", isSubagent: false }, old);
  store.handleEvent(PARENT, true, { kind: "turn_ended" }, old);
  store.handleEvent(CHILD, false, { kind: "session_meta", cwd: "D:\\local", isSubagent: false }, now - 2000);
  store.handleEvent(CHILD, false, { kind: "tool", name: "shell_command" }, now - 1000);
  store.setAppLiveness(true, now - 60_000);

  store.setDesktopSelection({ remote: true, remotePath: "/srv/selected" });
  expect(store.snapshot()!.remote).toBe(true);
  expect(store.snapshot()!.status).toBe("idle");
});

test("sessions older than the idle window are not shown", () => {
  const store = new CodexStore(() => {});
  const old = Date.now() - 20 * 60 * 1000;
  store.handleEvent(PARENT, false, { kind: "session_meta", isSubagent: false }, old);
  store.handleEvent(PARENT, false, { kind: "user_message" }, old);
  store.handleEvent(PARENT, false, { kind: "tool", name: "shell_command" }, old);
  expect(store.snapshot()).toBeUndefined();
});

test("a fresh event on an old session revives it", () => {
  const store = new CodexStore(() => {});
  const old = Date.now() - 20 * 60 * 1000;
  store.handleEvent(PARENT, false, { kind: "session_meta", isSubagent: false }, old);
  store.handleEvent(PARENT, false, { kind: "user_message" }, old);
  expect(store.snapshot()).toBeUndefined();
  store.handleEvent(PARENT, false, { kind: "tool", name: "shell_command" }, Date.now());
  expect(store.snapshot()?.status).toBe("working");
});

test("the running session wins over a more recently finished one", () => {
  const store = new CodexStore(() => {});
  const now = Date.now();
  store.handleEvent(PARENT, false, { kind: "session_meta", isSubagent: false }, now - 5000);
  store.handleEvent(PARENT, false, { kind: "user_message" }, now - 5000);
  store.handleEvent(PARENT, false, { kind: "tool", name: "shell_command" }, now - 4000);

  store.handleEvent(CHILD, false, { kind: "session_meta", isSubagent: false }, now - 3000);
  store.handleEvent(CHILD, false, { kind: "user_message" }, now - 2500);
  store.handleEvent(CHILD, false, { kind: "turn_ended" }, now - 1000);

  const snap = store.snapshot();
  expect(snap!.status).toBe("working");
  expect(snap!.action).toBe("Running a command");
});

test("when the running session finishes the presence follows the next running one", () => {
  const store = new CodexStore(() => {});
  const now = Date.now();
  store.handleEvent(PARENT, false, { kind: "session_meta", isSubagent: false }, now - 5000);
  store.handleEvent(PARENT, false, { kind: "tool", name: "shell_command" }, now - 4000);
  store.handleEvent(CHILD, false, { kind: "session_meta", isSubagent: false }, now - 3000);
  store.handleEvent(CHILD, false, { kind: "tool", name: "apply_patch", file: "config.ts" }, now - 2000);

  expect(store.snapshot()!.action).toBe("Editing config.ts");

  store.handleEvent(CHILD, false, { kind: "turn_ended" }, now - 500);
  expect(store.snapshot()!.action).toBe("Running a command");
});

test("thread settings update the model, effort and Fast mode mid-session", () => {
  const store = new CodexStore(() => {});
  feed(store, PARENT, [
    { kind: "session_meta", isSubagent: false },
    { kind: "turn_context", model: "gpt-5.6-sol", effort: "xhigh", planMode: false, realtime: false },
    { kind: "user_message" },
    { kind: "thread_settings", model: "gpt-5.6-luna", effort: "ultra", planMode: false, serviceTier: "priority" },
  ]);
  const snap = store.snapshot();
  expect(snap!.model).toEqual({ id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna" });
  expect(snap!.effort).toBe("ultra");
  expect(snap!.fastMode).toBe(true);
});

test("desktop thread settings update model and effort before the next prompt", () => {
  const store = new CodexStore(() => {});
  const now = Date.now();
  store.handleEvent(PARENT, false, { kind: "session_meta", isSubagent: false }, now - 2_000);
  store.handleEvent(
    PARENT,
    false,
    { kind: "turn_context", model: "gpt-5.6-sol", effort: "xhigh", planMode: false, realtime: false },
    now - 2_000,
  );
  store.handleEvent(PARENT, false, { kind: "turn_ended" }, now - 1_000);

  store.setSessionThreadSettings(PARENT, false, { model: "gpt-5.6-luna", effort: "ultra" }, now);

  expect(store.snapshot()!.model).toEqual({ id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna" });
  expect(store.snapshot()!.effort).toBe("ultra");
  store.dispose();
});

test("a settings selection observed before rollout priming beats older turn context", () => {
  const store = new CodexStore(() => {});
  const now = Date.now();
  store.setSessionThreadSettings(PARENT, false, { model: "gpt-5.6-luna", effort: "ultra" }, now);
  store.handleEvent(PARENT, false, { kind: "session_meta", isSubagent: false }, now - 2_000);
  store.handleEvent(
    PARENT,
    false,
    { kind: "turn_context", model: "gpt-5.6-sol", effort: "xhigh", planMode: false, realtime: false },
    now - 1_000,
  );

  expect(store.snapshot()!.model).toEqual({ id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna" });
  expect(store.snapshot()!.effort).toBe("ultra");
  store.dispose();
});

test("clearing a thread service tier returns to the Fast mode inherited from config", () => {
  const store = new CodexStore(() => {});
  store.setDefaultFastMode(true);
  feed(store, PARENT, [
    { kind: "session_meta", isSubagent: false },
    { kind: "turn_context", model: "gpt-5.6-sol", planMode: false, realtime: false },
    { kind: "user_message" },
  ]);
  expect(store.snapshot()!.fastMode).toBe(true);
  store.handleEvent(PARENT, false, { kind: "thread_settings", serviceTier: null });
  expect(store.snapshot()!.fastMode).toBe(true);
  store.dispose();
});

test("service-tier log updates apply before or after rollout discovery", () => {
  const store = new CodexStore(() => {});
  store.setSessionServiceTier(PARENT, false, "priority");
  feed(store, PARENT, [
    { kind: "session_meta", isSubagent: false },
    { kind: "user_message" },
  ]);
  expect(store.snapshot()!.fastMode).toBe(true);

  store.setSessionServiceTier(PARENT, false, "default");
  expect(store.snapshot()!.fastMode).toBe(false);
  store.setDefaultFastMode(true);
  store.setSessionServiceTier(PARENT, false, null);
  expect(store.snapshot()!.fastMode).toBe(true);
  store.dispose();
});

test("codex cost is split per model after a mid-session model switch", () => {
  const store = new CodexStore(() => {});
  feed(store, PARENT, [
    { kind: "session_meta", isSubagent: false },
    { kind: "turn_context", model: "gpt-5.4", effort: "high", planMode: false, realtime: false },
    { kind: "user_message" },
    { kind: "token_count", usage: { input: 1_000_000, cachedInput: 0, output: 100_000, reasoning: 0, total: 1_100_000 } },
    { kind: "turn_context", model: "gpt-5.5", effort: "high", planMode: false, realtime: false },
    { kind: "token_count", usage: { input: 2_000_000, cachedInput: 0, output: 200_000, reasoning: 0, total: 2_200_000 } },
  ]);
  const snap = store.snapshot();
  expect(snap?.usage).toEqual({ input: 2_000_000, output: 200_000, cacheRead: 0, cacheWrite: 0 });
  expect(snap?.costUsd).toBeCloseTo(12.0, 6);
});

test("codex presence persists as Idle when the app runs but the session went stale", () => {
  const store = new CodexStore(() => {});
  const old = Date.now() - 20 * 60 * 1000;
  store.handleEvent(PARENT, false, { kind: "session_meta", isSubagent: false }, old);
  store.handleEvent(PARENT, false, { kind: "user_message" }, old);
  expect(store.snapshot()).toBeUndefined();

  store.setAppLiveness(true);
  const snap = store.snapshot();
  expect(snap?.status).toBe("idle");
  expect(snap?.action).toBe("Idle");

  store.setAppLiveness(false);
  expect(store.snapshot()).toBeUndefined();
});

test("the codex elapsed timer anchors to the session start and survives switches", () => {
  const store = new CodexStore(() => {});
  const now = Date.now();
  store.handleEvent(PARENT, false, { kind: "session_meta", isSubagent: false }, now - 30_000);
  store.handleEvent(PARENT, false, { kind: "user_message" }, now - 30_000);
  const first = store.snapshot()!.startTimestamp!;
  expect(first).toBe(now - 30_000);

  store.handleEvent(CHILD, false, { kind: "session_meta", isSubagent: false }, now - 5_000);
  store.handleEvent(CHILD, false, { kind: "tool", name: "shell_command" }, now - 4_000);
  expect(store.snapshot()!.startTimestamp).toBe(first);
});

test("closing Codex hides a fresh local session immediately", () => {
  const store = new CodexStore(() => {});
  const now = Date.now();
  store.handleEvent(PARENT, false, { kind: "session_meta", isSubagent: false }, now);
  store.handleEvent(PARENT, false, { kind: "user_message" }, now);
  store.setAppLiveness(true);
  expect(store.snapshot()).toBeDefined();

  store.setAppLiveness(false);
  expect(store.snapshot()).toBeUndefined();
});

test("the first closed report hides a local codex session discovered during startup", () => {
  const store = new CodexStore(() => {});
  const now = Date.now();
  store.handleEvent(PARENT, false, { kind: "session_meta", isSubagent: false }, now);
  store.handleEvent(PARENT, false, { kind: "user_message" }, now);
  expect(store.snapshot()).toBeDefined();

  store.setAppLiveness(false);
  expect(store.snapshot()).toBeUndefined();
});

test("a remote codex session survives local app closure", () => {
  const store = new CodexStore(() => {}, { appCloseGraceMs: 10 });
  const now = Date.now();
  store.handleEvent(PARENT, true, { kind: "session_meta", isSubagent: false }, now - 60_000);
  store.handleEvent(PARENT, true, { kind: "user_message" }, now - 60_000);
  expect(store.snapshot()?.remote).toBe(true);
});

test("restarting Codex resets the elapsed timer to the new app start", () => {
  const store = new CodexStore(() => {});
  const now = Date.now();
  const firstStart = now - 60 * 60 * 1000;
  store.handleEvent(PARENT, false, { kind: "session_meta", isSubagent: false }, firstStart);
  store.handleEvent(PARENT, false, { kind: "user_message" }, now);
  store.setAppLiveness(true, firstStart);
  expect(store.snapshot()!.startTimestamp).toBe(firstStart);

  store.setAppLiveness(false);
  const restart = now - 20_000;
  store.setAppLiveness(true, restart);
  expect(store.snapshot()!.startTimestamp).toBe(restart);
});

test("small app start jitter does not move the codex timer", () => {
  const store = new CodexStore(() => {});
  const now = Date.now();
  store.handleEvent(PARENT, false, { kind: "session_meta", isSubagent: false }, now);
  store.handleEvent(PARENT, false, { kind: "user_message" }, now);
  const start = now - 100_000;
  store.setAppLiveness(true, start);
  expect(store.snapshot()!.startTimestamp).toBe(start);
  store.setAppLiveness(true, start + 3_000);
  expect(store.snapshot()!.startTimestamp).toBe(start);
});

test("a changed process set cannot move the codex timer while the app stays alive", () => {
  const store = new CodexStore(() => {});
  const now = Date.now();
  store.handleEvent(PARENT, false, { kind: "session_meta", isSubagent: false }, now);
  store.handleEvent(PARENT, false, { kind: "user_message" }, now);
  const appStart = now - 60 * 60 * 1000;
  store.setAppLiveness(true, appStart);
  expect(store.snapshot()!.startTimestamp).toBe(appStart);

  store.setAppLiveness(true, now - 10_000);
  expect(store.snapshot()!.startTimestamp).toBe(appStart);
});

test("subagent sessions never become the active presence", () => {
  const store = new CodexStore(() => {});
  feed(store, CHILD, [
    { kind: "session_meta", isSubagent: true, parentThreadId: PARENT },
    { kind: "tool", name: "shell_command" },
  ]);
  expect(store.snapshot()).toBeUndefined();
});
