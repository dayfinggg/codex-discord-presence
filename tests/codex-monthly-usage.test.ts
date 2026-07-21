import { expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexMonthlyUsage,
  readCodexMonthlyUsageRaw,
} from "../src/codex/monthly-usage.ts";

test("Codex monthly usage uses token deltas and deduplicates copied events", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-monthly-"));
  try {
    const sessions = join(home, "sessions", "2026", "07", "15");
    const copied = join(home, "sessions", "copied");
    await mkdir(sessions, { recursive: true });
    await mkdir(copied, { recursive: true });
    const lines = [
      { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      {
        timestamp: "2026-07-15T10:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, total_tokens: 110 },
            last_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, total_tokens: 110 },
          },
        },
      },
      {
        timestamp: "2026-07-15T10:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 160, cached_input_tokens: 50, output_tokens: 40, total_tokens: 200 },
          },
        },
      },
    ].map((value) => JSON.stringify(value)).join("\n");
    await writeFile(join(sessions, "rollout-a.jsonl"), lines);
    await writeFile(join(copied, "rollout-copy.jsonl"), lines);

    const raw = await readCodexMonthlyUsageRaw(home, new Date("2026-07-15T12:00:00Z"));
    expect(raw).toMatchObject({
      totalTokens: 200,
      usageByModel: {
        "gpt-5.6-sol": { input: 160, output: 40, cacheRead: 50, cacheWrite: 0 },
      },
    });
    expect(raw.day?.totalTokens).toBe(200);
    expect(raw.week?.totalTokens).toBe(200);
    expect(raw.allTime?.totalTokens).toBe(200);
    expect(codexMonthlyUsage(raw).costUsd).toBeGreaterThan(0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
