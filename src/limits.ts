import type { Limits, LimitWindow } from "./types.ts";

function pickWindow(
  a: LimitWindow | undefined,
  aAt: number,
  b: LimitWindow | undefined,
  bAt: number,
): LimitWindow | undefined {
  if (a && b) return aAt >= bAt ? a : b;
  return a ?? b;
}

export function mergeLimits(a?: Limits, b?: Limits): Limits | undefined {
  if (!a) return b;
  if (!b) return a;
  const fiveHour = pickWindow(a.fiveHour, a.updatedAt, b.fiveHour, b.updatedAt);
  const sevenDay = pickWindow(a.sevenDay, a.updatedAt, b.sevenDay, b.updatedAt);
  const fresher = a.updatedAt >= b.updatedAt ? a : b;
  const older = a.updatedAt >= b.updatedAt ? b : a;
  const scoped = fresher.sevenDayScoped ?? older.sevenDayScoped;
  const merged: Limits = { updatedAt: Math.max(a.updatedAt, b.updatedAt) };
  if (fiveHour) merged.fiveHour = fiveHour;
  if (sevenDay) merged.sevenDay = sevenDay;
  if (scoped) merged.sevenDayScoped = scoped;
  return merged;
}
