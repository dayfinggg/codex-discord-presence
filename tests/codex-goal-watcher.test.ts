import { expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasActiveGoal, readGoalState, readGoalStates } from "../src/codex/goal-watcher.ts";

const COMPLETE_THREAD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FIRST_THREAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_THREAD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("active goals stay associated with their Codex thread without exposing objectives", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-goals-"));
  const path = join(directory, "goals_1.sqlite");
  const database = new DatabaseSync(path);
  try {
    database.exec(`CREATE TABLE thread_goals (
      thread_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      time_used_seconds INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`);
    database.prepare("INSERT INTO thread_goals VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      COMPLETE_THREAD,
      "complete",
      "private complete goal",
      "complete",
      60,
      1_000,
      2_000,
    );
    database.close();

    expect(hasActiveGoal(path)).toBe(false);
    expect(readGoalState(path)).toEqual({ active: false });

    const writable = new DatabaseSync(path);
    writable.prepare("INSERT INTO thread_goals VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      FIRST_THREAD,
      "active",
      "private active goal",
      "active",
      125,
      3_000,
      4_000,
    );
    writable.close();
    expect(hasActiveGoal(path)).toBe(true);
    expect(readGoalState(path)).toEqual({ active: true, elapsedSeconds: 125, startedAt: 3_000, updatedAt: 4_000 });
    expect(readGoalState(path, SECOND_THREAD)).toEqual({ active: false });

    const newer = new DatabaseSync(path);
    newer.prepare("INSERT INTO thread_goals VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      SECOND_THREAD,
      "newer",
      "newer private goal",
      "active",
      3_665,
      5_000,
      6_000,
    );
    newer.close();
    expect(readGoalState(path)).toEqual({ active: true, elapsedSeconds: 3_665, startedAt: 5_000, updatedAt: 6_000 });
    expect(readGoalStates(path)).toEqual(
      new Map([
        [
          SECOND_THREAD,
          { active: true, elapsedSeconds: 3_665, startedAt: 5_000, updatedAt: 6_000 },
        ],
        [FIRST_THREAD, { active: true, elapsedSeconds: 125, startedAt: 3_000, updatedAt: 4_000 }],
      ]),
    );

    const update = new DatabaseSync(path);
    update.prepare("UPDATE thread_goals SET status = 'blocked' WHERE status = 'active'").run();
    update.close();
    expect(hasActiveGoal(path)).toBe(false);
  } finally {
    try {
      database.close();
    } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});
