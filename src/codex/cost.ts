import pricing from "../../pricing.json" with { type: "json" };

interface Price {
  input: number;
  cached: number;
  cacheWrite?: number;
  output: number;
}

const PRICES = pricing.codex.models as Record<string, Price>;
const FALLBACK = pricing.codex.fallback as Price;

export interface CodexCost {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  total: number;
}

export interface CodexUsageForCost {
  input: number;
  cachedInput: number;
  cacheWriteInput?: number;
  output: number;
}

function priceFor(modelId: string | undefined): Price {
  if (!modelId || modelId.trim() === "") return FALLBACK;
  let key = modelId.trim().toLowerCase();
  if (key.endsWith("-fast")) key = key.slice(0, -"-fast".length);
  return PRICES[key] ?? PRICES[key.replace(/-\d{4}-\d{2}-\d{2}$/, "")] ?? FALLBACK;
}

export function codexCost(modelId: string | undefined, usage: CodexUsageForCost): CodexCost {
  const price = priceFor(modelId);
  const cacheWriteInput = Math.max(0, Math.min(usage.input, usage.cacheWriteInput ?? 0));
  const cachedInput = Math.max(0, Math.min(usage.input - cacheWriteInput, usage.cachedInput));
  const nonCached = Math.max(0, usage.input - cachedInput - cacheWriteInput);
  const input = (nonCached / 1_000_000) * price.input;
  const cached = (cachedInput / 1_000_000) * price.cached;
  const cacheWrite = (cacheWriteInput / 1_000_000) * (price.cacheWrite ?? price.input * 1.25);
  const output = (usage.output / 1_000_000) * price.output;
  return { input, cached, cacheWrite, output, total: input + cached + cacheWrite + output };
}
