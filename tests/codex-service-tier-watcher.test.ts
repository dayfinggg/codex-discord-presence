import { expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexServiceTierCache,
  readThreadSettingsLogBatch,
  serviceTierFromConfig,
  serviceTierFromLogBody,
  threadSettingsFromLogBody,
} from "../src/codex/service-tier-watcher.ts";

test("serviceTierFromConfig reads the global service tier", () => {
  expect(serviceTierFromConfig('model = "gpt-5.6-sol"\nservice_tier = "priority"\n')).toBe("priority");
});

test("serviceTierFromConfig prefers the active profile", () => {
  const config = `
profile = "work"
service_tier = "default"

[profiles.work]
service_tier = "priority"
`;
  expect(serviceTierFromConfig(config)).toBe("priority");
});

test("serviceTierFromLogBody reads explicit and cleared thread overrides", () => {
  const prefix = "Submission thread_settings: ThreadSettingsOverrides { model: None, ";
  expect(serviceTierFromLogBody(`${prefix}service_tier: Some(Some("priority")), personality: None }`)).toBe(
    "priority",
  );
  expect(serviceTierFromLogBody(`${prefix}service_tier: Some(Some("default")), personality: None }`)).toBe(
    "default",
  );
  expect(serviceTierFromLogBody(`${prefix}service_tier: Some(None), personality: None }`)).toBeNull();
  expect(serviceTierFromLogBody(`${prefix}service_tier: None, personality: None }`)).toBeUndefined();
});

test("threadSettingsFromLogBody reads model and effort changes before a prompt is sent", () => {
  const body =
    'Submission sub=Submission { op: ThreadSettings { thread_settings: ThreadSettingsOverrides { model: Some("gpt-5.6-luna"), effort: Some(Some(Ultra)), service_tier: None } } }';
  expect(threadSettingsFromLogBody(body)).toEqual({
    model: "gpt-5.6-luna",
    effort: "ultra",
  });
});

test("readThreadSettingsLogBatch returns the latest value and timestamp for each setting", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-service-tier-"));
  const path = join(directory, "logs_2.sqlite");
  const database = new DatabaseSync(path);
  try {
    database.exec(`CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      ts_nanos INTEGER NOT NULL,
      target TEXT NOT NULL,
      thread_id TEXT,
      feedback_log_body TEXT
    )`);
    const insert = database.prepare(
      "INSERT INTO logs (ts, ts_nanos, target, thread_id, feedback_log_body) VALUES (?, ?, ?, ?, ?)",
    );
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    insert.run(
      100,
      100_000_000,
      "codex_core::session::handlers",
      first,
      'thread_settings: ThreadSettingsOverrides { model: Some("gpt-5.6-sol"), effort: Some(Some(High)), service_tier: Some(Some("priority")), personality: None }',
    );
    insert.run(
      101,
      200_000_000,
      "codex_core::session::handlers",
      first,
      'thread_settings: ThreadSettingsOverrides { model: Some("gpt-5.6-luna"), effort: Some(Some(Ultra)), service_tier: None, personality: None }',
    );
    insert.run(
      102,
      300_000_000,
      "codex_core::session::handlers",
      second,
      "thread_settings: ThreadSettingsOverrides { service_tier: Some(None), personality: None }",
    );
    insert.run(
      103,
      0,
      "other",
      second,
      'thread_settings: ThreadSettingsOverrides { service_tier: Some(Some("priority")) }',
    );

    const batch = readThreadSettingsLogBatch(path);
    expect(batch.lastId).toBe(3);
    expect(batch.updates).toEqual([
      { sessionId: first, updatedAt: 100_100, serviceTier: "priority" },
      { sessionId: first, updatedAt: 101_200, model: "gpt-5.6-luna", effort: "ultra" },
      { sessionId: second, updatedAt: 102_300, serviceTier: null },
    ]);

    insert.run(
      104,
      400_000_000,
      "codex_core::session::handlers",
      second,
      'thread_settings: ThreadSettingsOverrides { model: Some("gpt-5.6-terra"), effort: Some(Some(Medium)), service_tier: Some(Some("priority")), personality: None }',
    );
    expect(readThreadSettingsLogBatch(path, batch.lastId)).toEqual({
      lastId: 5,
      updates: [
        {
          sessionId: second,
          updatedAt: 104_400,
          model: "gpt-5.6-terra",
          effort: "medium",
          serviceTier: "priority",
        },
      ],
    });
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CodexServiceTierCache preserves recent settings without retaining cleared overrides", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-service-tier-cache-"));
  const path = join(directory, "cache.json");
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  const now = Date.now();
  try {
    const cache = new CodexServiceTierCache(path);
    cache.set(first, false, "priority", now);
    cache.set(second, true, "default", now);
    expect(new CodexServiceTierCache(path).load(now)).toEqual([
      { sessionId: first, remote: false, serviceTier: "priority" },
      { sessionId: second, remote: true, serviceTier: "default" },
    ]);

    cache.set(first, false, null, now + 1);
    expect(new CodexServiceTierCache(path).load(now + 1)).toEqual([
      { sessionId: second, remote: true, serviceTier: "default" },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
