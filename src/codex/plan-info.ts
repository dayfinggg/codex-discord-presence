import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createLogger } from "../util/logger.ts";

const log = createLogger("codex-plan");
const CACHE_TTL_MS = 60 * 60 * 1000;

const PLAN_NAMES: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro 20X",
  prolite: "Pro 5X",
  pro_lite: "Pro 5X",
  team: "Team",
  business: "Business",
  self_serve_business_usage_based: "Business",
  enterprise: "Enterprise",
  enterprise_cbp_usage_based: "Enterprise",
  edu: "Edu",
  education: "Edu",
};

export function planName(planType: string | undefined): string | undefined {
  if (!planType) return undefined;
  return PLAN_NAMES[planType.toLowerCase()];
}

function decodePlanType(idToken: string): string | undefined {
  const segment = idToken.split(".")[1];
  if (!segment) return undefined;
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  let json: string;
  try {
    json = Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return undefined;
  }
  try {
    const payload = JSON.parse(json) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    const value = auth?.chatgpt_plan_type;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

let cached: { name: string | undefined; at: number } | undefined;

export async function getCodexPlanName(codexHome: string): Promise<string | undefined> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.name;
  let planType: string | undefined;
  try {
    const raw = await readFile(join(codexHome, "auth.json"), "utf8");
    const auth = JSON.parse(raw) as { tokens?: { id_token?: string } };
    const idToken = auth.tokens?.id_token;
    if (idToken) planType = decodePlanType(idToken);
  } catch (err) {
    log.warn(`could not read codex plan: ${(err as Error).message}`);
  }
  const name = planName(planType);
  cached = { name, at: now };
  return name;
}
