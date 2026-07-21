import { test, expect } from "vitest";
import { planName } from "../src/codex/plan-info.ts";

test("known plan types render without the ChatGPT prefix", () => {
  expect(planName("pro")).toBe("Pro 20X");
  expect(planName("prolite")).toBe("Pro 5X");
  expect(planName("pro_lite")).toBe("Pro 5X");
  expect(planName("plus")).toBe("Plus");
  expect(planName("go")).toBe("Go");
  expect(planName("team")).toBe("Team");
  expect(planName("business")).toBe("Business");
  expect(planName("self_serve_business_usage_based")).toBe("Business");
  expect(planName("enterprise")).toBe("Enterprise");
  expect(planName("edu")).toBe("Edu");
  expect(planName("free")).toBe("Free");
});

test("case insensitive", () => {
  expect(planName("PRO")).toBe("Pro 20X");
});

test("unknown and missing return undefined", () => {
  expect(planName("mystery")).toBeUndefined();
  expect(planName(undefined)).toBeUndefined();
});
