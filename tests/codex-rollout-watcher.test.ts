import { test, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RolloutWatcher } from "../src/codex/rollout-watcher.ts";
import type { CodexEvent } from "../src/codex/rollout-parser.ts";

const SESSION_ID = "44444444-4444-4444-8444-444444444444";

test("priming a session larger than the tail window still recovers model and effort", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-watch-"));
  const dir = join(home, "sessions", "2025", "01", "02");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `rollout-2025-01-02T03-04-05-${SESSION_ID}.jsonl`);

  const meta =
    '{"timestamp":"2025-01-02T03:04:05.000Z","type":"session_meta","payload":{"id":"synthetic-session","cwd":"C:\\\\example","source":"cli","thread_source":"user"}}';
  const context =
    '{"timestamp":"2025-01-02T03:04:06.000Z","type":"turn_context","payload":{"model":"gpt-5.6-sol","effort":"xhigh","collaboration_mode":{"mode":"default"}}}';
  const settings =
    '{"timestamp":"2025-01-02T03:04:07.000Z","type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"gpt-5.6-luna","reasoning_effort":"ultra"}}}';
  const filler =
    '{"timestamp":"2025-01-02T03:04:08.000Z","type":"event_msg","payload":{"type":"agent_message","message":"' +
    "x".repeat(2048) +
    '"}}';
  const fillerCount = Math.ceil((300 * 1024) / filler.length);
  const tail =
    '{"timestamp":"2025-01-02T03:04:09.000Z","type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"await tools.shell_command({command: \\"Get-ChildItem synthetic-fixtures\\"});"}}';

  const lines = [meta, context, settings, ...Array(fillerCount).fill(filler), tail];
  await writeFile(file, lines.join("\n") + "\n", "utf8");

  const events: CodexEvent[] = [];
  const watcher = new RolloutWatcher(home, (sessionId, _remote, event) => {
    if (sessionId === SESSION_ID) events.push(event);
  });
  await watcher.start();
  watcher.stop();
  await rm(home, { recursive: true, force: true });

  expect(events.some((e) => e.kind === "session_meta")).toBe(true);
  expect(events.some((e) => e.kind === "turn_context" && e.model === "gpt-5.6-sol" && e.effort === "xhigh")).toBe(
    true,
  );
  expect(
    events.some((e) => e.kind === "thread_settings" && e.model === "gpt-5.6-luna" && e.effort === "ultra"),
  ).toBe(true);
  expect(events.some((e) => e.kind === "tool" && e.name === "search_files")).toBe(true);
});

test("polling discovers a session created when recursive watching is unavailable", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-watch-poll-"));
  const dir = join(home, "sessions", "2026", "07", "21");
  await mkdir(dir, { recursive: true });
  const events: CodexEvent[] = [];
  const watcher = new RolloutWatcher(home, (_sessionId, _remote, event) => events.push(event));
  const file = join(dir, `rollout-2026-07-21T12-00-00-${SESSION_ID}.jsonl`);

  try {
    await writeFile(
      file,
      '{"timestamp":"2026-07-21T12:00:00.000Z","type":"session_meta","payload":{"id":"x","cwd":"C:\\\\w","source":"vscode","thread_source":"user"}}\n',
      "utf8",
    );
    await (watcher as unknown as { poll(): Promise<void> }).poll();
  } finally {
    watcher.stop();
    await rm(home, { recursive: true, force: true });
  }

  expect(events.some((event) => event.kind === "session_meta")).toBe(true);
});
