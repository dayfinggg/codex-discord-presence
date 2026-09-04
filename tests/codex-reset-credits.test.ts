import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "vitest";
import {
  CodexResetCreditsWatcher,
  limitsFromRateLimitsResponse,
  resetCreditsFromRateLimitsResponse,
  type ResetCreditsReader,
} from "../src/codex/reset-credits-watcher.ts";

test("reads independent reset credits from the current Codex app-server response", () => {
  expect(
    resetCreditsFromRateLimitsResponse({
      result: {
        rateLimits: { primary: {}, secondary: {} },
        rateLimitResetCredits: { availableCount: 5, credits: [{ status: "available" }] },
      },
    }),
  ).toBe(5);
});

test("supports the snake-case reset-credit response", () => {
  expect(
    resetCreditsFromRateLimitsResponse({
      rate_limit_reset_credits: { available_count: 1 },
    }),
  ).toBe(1);
});

test("does not confuse limit reset timestamps with independent reset credits", () => {
  expect(
    resetCreditsFromRateLimitsResponse({
      result: { rateLimits: { primary: { resetsAt: 1_800_000_000 } } },
    }),
  ).toBeUndefined();
});

test("reads the authoritative account limit instead of a model-specific limit", () => {
  const updatedAt = 1_700_000_000_000;
  expect(
    limitsFromRateLimitsResponse(
      {
        result: {
          rateLimits: {
            limitId: "codex",
            primary: {
              usedPercent: 3,
              windowDurationMins: 10_080,
              resetsAt: 1_784_780_151,
            },
          },
          rateLimitsByLimitId: {
            codex_bengalfox: {
              primary: { usedPercent: 0, windowDurationMins: 10_080 },
            },
          },
        },
      },
      updatedAt,
    ),
  ).toEqual({
    sevenDay: { usedPercentage: 3, resetsAt: 1_784_780_151_000 },
    updatedAt,
  });
});

test("supports snake-case rate-limit windows", () => {
  expect(
    limitsFromRateLimitsResponse(
      {
        rate_limits: {
          primary: { used_percent: 12, window_minutes: 300, resets_at: 1_800_000_000 },
        },
      },
      42,
    ),
  ).toEqual({ fiveHour: { usedPercentage: 12, resetsAt: 1_800_000_000_000 }, updatedAt: 42 });
});

test("falls back to the canonical Codex entry in the multi-limit map", () => {
  expect(
    limitsFromRateLimitsResponse(
      {
        result: {
          rateLimits: null,
          rateLimitsByLimitId: {
            codex_bengalfox: {
              limitId: "codex_bengalfox",
              primary: { usedPercent: 0, windowDurationMins: 10_080 },
            },
            codex: {
              limitId: "codex",
              primary: { usedPercent: 41, windowDurationMins: 10_079 },
            },
          },
        },
      },
      42,
    ),
  ).toEqual({ sevenDay: { usedPercentage: 41 }, updatedAt: 42 });
});

test("reuses one Codex app-server process across periodic reads", async () => {
  let readers = 0;
  let reads = 0;
  let closes = 0;
  const watcher = new CodexResetCreditsWatcher(
    () => {},
    10,
    () => {
      readers++;
      const reader: ResetCreditsReader = {
        read: async () => {
          reads++;
          return { ok: true, available: 3 };
        },
        close: () => {
          closes++;
        },
      };
      return reader;
    },
    () => [{ executable: "codex", args: [] }],
  );

  watcher.start();
  for (let i = 0; i < 100 && reads < 3; i++) await sleep(10);
  watcher.stop();

  expect(readers).toBe(1);
  expect(reads).toBeGreaterThanOrEqual(3);
  expect(closes).toBe(1);
});

test("stopping during the first read closes the child and ignores the late response", async () => {
  let finish: ((value: { ok: boolean; available: number }) => void) | undefined;
  let closes = 0;
  let updates = 0;
  const watcher = new CodexResetCreditsWatcher(
    () => updates++,
    10,
    () => ({
      read: () => new Promise((resolve) => { finish = resolve; }),
      close: () => { closes++; },
    }),
    () => [{ executable: "codex", args: [] }],
  );
  watcher.start();
  expect(finish).toBeDefined();
  watcher.stop();
  finish!({ ok: true, available: 4 });
  await sleep(0);
  expect(closes).toBe(1);
  expect(updates).toBe(0);
});
