export type EffortLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type SessionStatus = "new" | "thinking" | "working" | "idle" | "waiting";

export interface ModelInfo {
  id: string;
  displayName: string;
}

export interface LimitWindow {
  usedPercentage: number;
  resetsAt?: number;
}

export interface ScopedLimit {
  label: string;
  usedPercentage: number;
}

export interface Limits {
  fiveHour?: LimitWindow;
  sevenDay?: LimitWindow;
  sevenDayScoped?: ScopedLimit[];
  updatedAt: number;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface MonthlyUsage {
  totalTokens: number;
  costUsd: number;
  day?: UsagePeriod;
  week?: UsagePeriod;
  allTime?: UsagePeriod;
}

export interface UsagePeriod {
  totalTokens: number;
  costUsd: number;
}

export interface GoalState {
  active: boolean;
  elapsedSeconds?: number;
  startedAt?: number;
  updatedAt?: number;
}

export interface PresenceState {
  planName: string;
  resetCreditsAvailable?: number;
  limits?: Limits;
  model?: ModelInfo;
  effort?: EffortLevel;
  action: string;
  status: SessionStatus;
  thinkingSeconds?: number;
  planMode: boolean;
  agentsRunning: number;
  agentsIdle: number;
  startTimestamp?: number;
  usage?: UsageTotals;
  costUsd?: number;
  costBreakdown?: CostBreakdown;
  monthlyUsage?: MonthlyUsage;
  remote?: boolean;
  contextPct?: number;
  realtime?: boolean;
  goalActive?: boolean;
  goalElapsedSeconds?: number;
  fastMode?: boolean;
}
