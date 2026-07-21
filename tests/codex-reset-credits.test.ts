import { expect, test } from "vitest";
import {
  limitsFromRateLimitsResponse,
  resetCreditsFromRateLimitsResponse,
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
