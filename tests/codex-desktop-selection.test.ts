import { test, expect } from "vitest";
import { parseCodexDesktopSelection, parseCodexUiSelection } from "../src/codex/desktop-selection.ts";

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
