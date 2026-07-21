import pricing from "../../pricing.json" with { type: "json" };

interface Price {
  input: number;
  cached: number;
  output: number;
}

const PRICES = pricing.codex.models as Record<string, Price>;
const FALLBACK = pricing.codex.fallback as Price;

export interface CodexCost {
  input: number;
  cached: number;
  output: number;
  total: number;
}

export interface CodexUsageForCost {
  input: number;
  cachedInput: number;
  output: number;
}

function priceFor(modelId: string | undefined): Price {
  if (!modelId || modelId.trim() === "") return FALLBACK;
  let key = modelId.toLowerCase();
  if (key.endsWith("-fast")) key = key.slice(0, -"-fast".length);
  return PRICES[key] ?? PRICES[key.replace(/-\d{4}-\d{2}-\d{2}$/, "")] ?? FALLBACK;
}

export function codexCost(modelId: string | undefined, usage: CodexUsageForCost): CodexCost {
  const price = priceFor(modelId);
  const nonCached = Math.max(0, usage.input - usage.cachedInput);
  const input = (nonCached / 1_000_000) * price.input;
  const cached = (usage.cachedInput / 1_000_000) * price.cached;
  const output = (usage.output / 1_000_000) * price.output;
  return { input, cached, output, total: input + cached + output };
}
