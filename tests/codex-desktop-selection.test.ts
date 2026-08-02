import { test, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { LOCAL_SESSION_BY_TITLE_QUERY, parseCodexDesktopSelection, parseCodexUiSelection, selectLocalSessionByTitle } from "../src/codex/desktop-selection.ts";

test("local title lookup never selects an untitled background session", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE threads (id TEXT, title TEXT, archived INTEGER, recency_at_ms INTEGER, updated_at_ms INTEGER)");
  database.exec("INSERT INTO threads VALUES ('untitled', '', 0, 2, 2), ('selected', 'Selected chat', 0, 1, 1)");
  const row = database.prepare(LOCAL_SESSION_BY_TITLE_QUERY)
    .get("Selected chat activity", "Selected chat activity%", "Selected chat activity") as { id?: unknown } | undefined;
  expect(row?.id).toBe("selected");
  database.close();
});

test("generated Desktop title resolves the matching session in the selected project", () => {
  expect(selectLocalSessionByTitle("Исправить запуск сервиса активности", [
    { id: "selected", title: "Сервис активности не запустился после перезагрузки ПК, проверить почему и исправить.", cwd: "\\\\?\\D:\\work" },
    { id: "background", title: "Исправить запуск сервиса в фоне", cwd: "\\\\?\\D:\\other" },
  ], ["D:\\work"])).toBe("selected");
});

test("generated Desktop title does not guess from a weak match", () => {
  expect(selectLocalSessionByTitle("Проверить активность", [
    { id: "background", title: "Проверить сборку приложения", cwd: "D:\\work" },
  ], ["D:\\work"])).toBeUndefined();
});

test("UI selection protocol accepts desktop and CLI selections", () => {
  expect(parseCodexUiSelection('{"kind":"desktop","title":"Selected chat"}')).toEqual({
    kind: "desktop",
    title: "Selected chat",
  });
  expect(parseCodexUiSelection('{"kind":"cli","pid":1234}')).toEqual({ kind: "cli", pid: 1234 });
});

test("UI selection protocol rejects malformed selections", () => {
  expect(parseCodexUiSelection('{"kind":"desktop","title":""}')).toBeUndefined();
  expect(parseCodexUiSelection('{"kind":"cli","pid":0}')).toBeUndefined();
  expect(parseCodexUiSelection("{")).toBeUndefined();
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
