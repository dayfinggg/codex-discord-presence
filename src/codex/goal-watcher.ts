import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { GoalState } from "../types.ts";
import { createLogger } from "../util/logger.ts";

const log = createLogger("codex-goals");
const DEFAULT_POLL_MS = 2_000;

interface GoalRow {
  threadId: string;
  elapsedSeconds: number | null;
  startedAt: number | null;
  updatedAt: number | null;
}

function finiteNonNegative(value: number | null): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function readGoalStates(databasePath: string): Map<string, GoalState> {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database
      .prepare(
        `SELECT thread_id AS threadId,
                time_used_seconds AS elapsedSeconds,
                created_at_ms AS startedAt,
                updated_at_ms AS updatedAt
           FROM thread_goals
          WHERE status = 'active'
          ORDER BY updated_at_ms DESC`,
      )
      .all() as unknown as GoalRow[];
    const states = new Map<string, GoalState>();
    for (const row of rows) {
      const threadId = row.threadId.trim().toLowerCase();
      if (threadId === "") continue;
      states.set(threadId, {
        active: true,
        elapsedSeconds: finiteNonNegative(row.elapsedSeconds),
        startedAt: finiteNonNegative(row.startedAt),
        updatedAt: finiteNonNegative(row.updatedAt),
      });
    }
    return states;
  } finally {
    database.close();
  }
}

export function readGoalState(databasePath: string, threadId?: string): GoalState {
  const states = readGoalStates(databasePath);
  if (threadId) return states.get(threadId.toLowerCase()) ?? { active: false };
  return [...states.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0] ?? { active: false };
}

export function hasActiveGoal(databasePath: string, threadId?: string): boolean {
  return readGoalState(databasePath, threadId).active;
}

export class CodexGoalWatcher {
  private timer?: ReturnType<typeof setInterval>;
  private lastStateKey?: string;
  private stopped = false;

  constructor(
    private readonly codexHome: string,
    private readonly onUpdate: (states: ReadonlyMap<string, GoalState>) => void,
    private readonly intervalMs = DEFAULT_POLL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private poll(): void {
    if (this.stopped) return;
    try {
      const states = readGoalStates(join(this.codexHome, "goals_1.sqlite"));
      const stateKey = [...states]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([threadId, state]) => `${threadId}:${state.startedAt ?? "unknown"}:${Math.floor((state.elapsedSeconds ?? 0) / 60)}`)
        .join("|");
      if (stateKey === this.lastStateKey) return;
      this.lastStateKey = stateKey;
      log.debug(`active sessions=${states.size}`);
      this.onUpdate(states);
    } catch (err) {
      log.debug(`goal poll failed: ${(err as Error).message}`);
    }
  }
}
