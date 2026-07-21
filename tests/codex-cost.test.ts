import { test, expect } from "vitest";
import { codexCost } from "../src/codex/cost.ts";

test("prices non-cached input, cached input and output separately", () => {
  const cost = codexCost("gpt-5.5", { input: 1_000_000, cachedInput: 200_000, output: 100_000 });
  expect(cost.input).toBeCloseTo(4.0, 6);
  expect(cost.cached).toBeCloseTo(0.1, 6);
  expect(cost.output).toBeCloseTo(3.0, 6);
  expect(cost.total).toBeCloseTo(7.1, 6);
});

test("cached tokens are a subset of input and never double counted", () => {
  const cost = codexCost("gpt-5.4", { input: 500_000, cachedInput: 500_000, output: 0 });
  expect(cost.input).toBeCloseTo(0, 6);
  expect(cost.cached).toBeCloseTo((500_000 / 1_000_000) * 0.25, 6);
  expect(cost.total).toBeCloseTo(0.125, 6);
});

test("gpt-5.4-mini uses the official mini rate", () => {
  const cost = codexCost("gpt-5.4-mini", { input: 1_000_000, cachedInput: 0, output: 1_000_000 });
  expect(cost.input).toBeCloseTo(0.75, 6);
  expect(cost.output).toBeCloseTo(4.5, 6);
});

test("the gpt-5.6 alias is priced like gpt-5.6-sol", () => {
  const alias = codexCost("gpt-5.6", { input: 1_000_000, cachedInput: 0, output: 1_000_000 });
  const sol = codexCost("gpt-5.6-sol", { input: 1_000_000, cachedInput: 0, output: 1_000_000 });
  expect(alias.total).toBeCloseTo(sol.total, 6);
});

test("gpt-5.6 family uses the official rates", () => {
  const sol = codexCost("gpt-5.6-sol", { input: 1_000_000, cachedInput: 0, output: 1_000_000 });
  expect(sol.input).toBeCloseTo(5, 6);
  expect(sol.output).toBeCloseTo(30, 6);
  const terra = codexCost("gpt-5.6-terra", { input: 1_000_000, cachedInput: 0, output: 1_000_000 });
  expect(terra.input).toBeCloseTo(2.5, 6);
  expect(terra.output).toBeCloseTo(15, 6);
  const luna = codexCost("gpt-5.6-luna", { input: 1_000_000, cachedInput: 1_000_000, output: 1_000_000 });
  expect(luna.input).toBeCloseTo(0, 6);
  expect(luna.cached).toBeCloseTo(0.1, 6);
  expect(luna.output).toBeCloseTo(6, 6);
});

test("dated snapshots map to the base model price", () => {
  const base = codexCost("gpt-5.6-terra", { input: 1_000_000, cachedInput: 0, output: 1_000_000 });
  const dated = codexCost("gpt-5.6-terra-2026-08-01", { input: 1_000_000, cachedInput: 0, output: 1_000_000 });
  expect(dated.total).toBeCloseTo(base.total, 6);
});

test("the -fast suffix maps to the base model price", () => {
  const base = codexCost("gpt-5.5", { input: 1_000_000, cachedInput: 0, output: 0 });
  const fast = codexCost("gpt-5.5-fast", { input: 1_000_000, cachedInput: 0, output: 0 });
  expect(fast.total).toBeCloseTo(base.total, 6);
});

test("unknown models fall back to the codex family rate", () => {
  const cost = codexCost("gpt-9-unknown", { input: 1_000_000, cachedInput: 0, output: 1_000_000 });
  expect(cost.input).toBeCloseTo(1.25, 6);
  expect(cost.output).toBeCloseTo(10, 6);
});
