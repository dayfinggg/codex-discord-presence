import { setTimeout as sleep } from "node:timers/promises";
import { test, expect } from "vitest";
import { DatabaseSync as Database } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexDesktopSelectionWatcher, type CodexDesktopSelection, localProjectRootsFromState, parseCodexDesktopSelection, parseCodexModelLabel, parseCodexUiSelection, selectLocalSessionByTitle, selectionForCodexCliSession } from "../src/codex/desktop-selection.ts";

test("local title lookup never selects an untitled background session", () => {
  expect(selectLocalSessionByTitle("Selected chat", [
    { id: "untitled", title: "", cwd: "D:\\work" },
    { id: "selected", title: "Selected chat", cwd: "D:\\work" },
  ])).toBe("selected");
});

test("watcher follows generated names, settings changes, and delayed database discovery", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-selection-"));
  const updates: CodexDesktopSelection[] = [];
  const database = new Database(join(home, "state_5.sqlite"));
  const watcher = new CodexDesktopSelectionWatcher(home, (value) => updates.push(value), { pollMs: 10, watchUi: false });
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 1500;
    while (!predicate() && Date.now() < deadline) await sleep(10);
    expect(predicate()).toBe(true);
  };
  try {
    database.exec("CREATE TABLE threads (id TEXT, title TEXT, name TEXT, cwd TEXT, archived INTEGER, recency_at_ms INTEGER, updated_at_ms INTEGER)");
    database.exec("INSERT INTO threads VALUES ('first', 'An unrelated original prompt', 'Selected chat', 'D:/work', 0, 1, 1)");
    writeFileSync(join(home, ".codex-global-state.json"), "{}");
    watcher.setUiSelection({ kind: "desktop", title: "Selected chat", model: "gpt-6-astra", effort: "high" });
    watcher.start();
    await waitFor(() => updates.at(-1)?.sessionId === "first");
    watcher.setUiSelection({ kind: "desktop", title: "Selected chat", model: "gpt-5.6-sol", effort: "xhigh" });
    expect(updates.at(-1)).toMatchObject({ sessionId: "first", model: "gpt-5.6-sol", effort: "xhigh" });
    watcher.setUiSelection({ kind: "desktop", title: "New task", model: "gpt-6-astra", effort: "low" });
    expect(updates.at(-1)?.sessionId).toBeUndefined();
    database.exec("INSERT INTO threads VALUES ('second', 'Another original prompt', 'New task', 'D:/work', 0, 2, 2)");
    await waitFor(() => updates.at(-1)?.sessionId === "second");
    watcher.setUiSelection({ kind: "desktop", title: "Selected chat", model: "gpt-5.6-sol", effort: "xhigh" });
    expect(updates.at(-1)?.sessionId).toBe("first");
  } finally {
    watcher.stop();
    database.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("generated Desktop title resolves the matching session in the selected project", () => {
  expect(selectLocalSessionByTitle("Исправить запуск сервиса активности", [
    { id: "selected", title: "Сервис активности не запустился после перезагрузки ПК, проверить почему и исправить.", cwd: "\\\\?\\D:\\work" },
    { id: "background", title: "Исправить запуск сервиса в фоне", cwd: "\\\\?\\D:\\other" },
  ], ["D:\\work"])).toBe("selected");
});

test("selected project roots override stale active workspace roots", () => {
  expect(localProjectRootsFromState(JSON.stringify({
    "selected-project": { type: "local", projectId: "codex" },
    "local-projects": { codex: { rootPaths: ["C:\\Users\\example\\.codex"] } },
    "active-workspace-roots": ["D:\\work"],
  }))).toEqual(["C:\\Users\\example\\.codex"]);
});

test("generated Desktop title does not guess from a weak match", () => {
  expect(selectLocalSessionByTitle("Проверить активность", [
    { id: "background", title: "Проверить сборку приложения", cwd: "D:\\work" },
  ], ["D:\\work"])).toBeUndefined();
});

test("UI selection protocol accepts desktop and CLI selections", () => {
  expect(parseCodexUiSelection('{"kind":"desktop","title":"Selected chat","modelLabel":"5.6 Sol Medium"}')).toEqual({
    kind: "desktop",
    title: "Selected chat",
    model: "gpt-5.6-sol",
    effort: "medium",
  });
  expect(parseCodexUiSelection('{"kind":"cli","pid":1234}')).toEqual({ kind: "cli", pid: 1234 });
});

test("Desktop model labels tolerate separators and Fast mode", () => {
  expect(parseCodexModelLabel("5.6 Terra · High Fast")).toEqual({
    model: "gpt-5.6-terra",
    effort: "high",
  });
  expect(parseCodexModelLabel("Codex")).toEqual({});
});

test("Desktop model labels keep Astra and multiword reasoning separate", () => {
  expect(parseCodexModelLabel("GPT-6 Astra High")).toEqual({ model: "gpt-6-astra", effort: "high" });
  expect(parseCodexModelLabel("6 Astra · Extra High Fast")).toEqual({ model: "gpt-6-astra", effort: "xhigh" });
  expect(parseCodexModelLabel("5.6 Sol (Extra high)")).toEqual({ model: "gpt-5.6-sol", effort: "xhigh" });
  expect(parseCodexModelLabel("GPT-5.6 Luna None")).toEqual({ model: "gpt-5.6-luna", effort: "none" });
  expect(parseCodexModelLabel("5.6 Terra Light")).toEqual({ model: "gpt-5.6-terra", effort: "low" });
});

test("exact generated titles win over shared prompt words", () => {
  expect(selectLocalSessionByTitle("Fix model selection", [
    { id: "background", title: "Fix model selection and performance", cwd: "D:\\work" },
    { id: "selected", title: "Fix model selection", cwd: "D:\\work" },
  ], ["D:\\work"])).toBe("selected");
});

test("POSIX project paths stay case sensitive while Windows paths do not", () => {
  const candidates = [
    { id: "upper", title: "Selected chat", cwd: "/srv/Project" },
    { id: "lower", title: "Selected chat", cwd: "/srv/project" },
  ];
  expect(selectLocalSessionByTitle("Selected chat", candidates, ["/srv/Project"])).toBe("upper");
  expect(selectLocalSessionByTitle("Selected chat", candidates, ["/srv/project"])).toBe("lower");
  expect(selectLocalSessionByTitle("Selected chat", [{ id: "windows", title: "Selected chat", cwd: "C:\\Project" }], ["c:/project"])).toBe("windows");
});

test("an unresolved foreground CLI never clears the selected Desktop chat", () => {
  expect(selectionForCodexCliSession(undefined)).toBeUndefined();
  expect(selectionForCodexCliSession("019fd1e3-bc69-7710-ac1a-406578518026")).toEqual({
    remote: false,
    sessionId: "019fd1e3-bc69-7710-ac1a-406578518026",
  });
});

test("UI selection protocol rejects malformed selections", () => {
  expect(parseCodexUiSelection('{"kind":"desktop","title":"","project":"app","remote":false}')).toBeUndefined();
  expect(parseCodexUiSelection('{"kind":"cli","pid":0}')).toBeUndefined();
  expect(parseCodexUiSelection("{" )).toBeUndefined();
});

test("local desktop selection is detected when no remote project is active", () => {
  expect(parseCodexDesktopSelection('{"active-workspace-roots":["D:\\\\work"]}')).toEqual({ remote: false });
});

test("active remote project resolves its path", () => {
  const raw = JSON.stringify({
    "active-remote-project-id": "project-2",
    "remote-projects": [
      { id: "project-1", remotePath: "/srv/one" },
      { id: "project-2", remotePath: "/srv/two" },
    ],
  });
  expect(parseCodexDesktopSelection(raw)).toEqual({ remote: true, remotePath: "/srv/two" });
});

test("current selected-project overrides the stale legacy active remote project", () => {
  const raw = JSON.stringify({
    "selected-project": { type: "remote", projectId: "project-2" },
    "active-remote-project-id": "project-1",
    "remote-projects": [
      { id: "project-1", remotePath: "/srv/old" },
      { id: "project-2", remotePath: "/srv/current" },
    ],
  });
  expect(parseCodexDesktopSelection(raw)).toEqual({ remote: true, remotePath: "/srv/current" });
});

test("current local selected-project overrides a stale remote project", () => {
  const raw = JSON.stringify({
    "selected-project": { type: "local", projectId: "local-1" },
    "active-remote-project-id": "project-1",
    "remote-projects": [{ id: "project-1", remotePath: "/srv/old" }],
  });
  expect(parseCodexDesktopSelection(raw)).toEqual({ remote: false });
});

test("projectless chat ignores a stale legacy remote project", () => {
  const raw = JSON.stringify({
    "local-projects": {},
    "projectless-thread-ids": ["019f81c8-b0d2-7860-980a-df970fde22e5"],
    "active-remote-project-id": "project-1",
    "remote-projects": [{ id: "project-1", remotePath: "/srv/old" }],
  });
  expect(parseCodexDesktopSelection(raw)).toEqual({ remote: false });
});

test("malformed desktop state is ignored", () => {
  expect(parseCodexDesktopSelection("{" )).toBeUndefined();
});
