import { expect, test } from "vitest";
import {
  CODEX_WINDOWS_PROCESS_RULES,
  matchesWindowsProcess,
  parseElapsedTimeSeconds,
  parsePosixProcessList,
  processCommandName,
  type WindowsProcessInfo,
  type WindowsProcessRule,
} from "../src/util/process-liveness.ts";

function matches(info: WindowsProcessInfo, rules: readonly WindowsProcessRule[]): boolean {
  return rules.some((rule) => matchesWindowsProcess(info, rule));
}

function processInfo(overrides: Partial<WindowsProcessInfo>): WindowsProcessInfo {
  return {
    pid: 1234,
    name: "codex",
    path: "",
    commandLine: "",
    hasMainWindow: false,
    startedAt: Date.now(),
    ...overrides,
  };
}

test("Codex ignores plugin app-server processes", () => {
  const plugin = processInfo({
    path: "C:\\Users\\example\\.codex\\plugins\\.plugin-appserver\\codex.exe",
    commandLine: '"C:\\Users\\example\\.codex\\plugins\\.plugin-appserver\\codex.exe" app-server',
  });
  expect(matches(plugin, CODEX_WINDOWS_PROCESS_RULES)).toBe(false);
});

test("Codex Desktop requires the package main window", () => {
  const main = processInfo({
    name: "ChatGPT",
    path: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0_x64\\app\\ChatGPT.exe",
    commandLine: '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0_x64\\app\\ChatGPT.exe"',
    hasMainWindow: true,
  });
  expect(matches(main, CODEX_WINDOWS_PROCESS_RULES)).toBe(true);
  expect(matches({ ...main, hasMainWindow: false }, CODEX_WINDOWS_PROCESS_RULES)).toBe(false);
});

test("Codex CLI remains a valid live process regardless of its user-specific install path", () => {
  const cli = processInfo({
    path: "C:\\Users\\example\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\codex.exe",
    commandLine: '"C:\\Users\\example\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\codex.exe"',
  });
  expect(matches(cli, CODEX_WINDOWS_PROCESS_RULES)).toBe(true);
});

test("POSIX elapsed time supports Linux seconds and macOS ps clocks", () => {
  expect(parseElapsedTimeSeconds("125")).toBe(125);
  expect(parseElapsedTimeSeconds("02:05")).toBe(125);
  expect(parseElapsedTimeSeconds("01:02:05")).toBe(3_725);
  expect(parseElapsedTimeSeconds("2-01:02:05")).toBe(176_525);
  expect(parseElapsedTimeSeconds("1-24:00:00")).toBeUndefined();
});

test("POSIX process parsing recognizes Codex CLI and Desktop executable paths", () => {
  const now = 2_000_000;
  const result = parsePosixProcessList(
    "101 20 /usr/local/bin/codex\n202 01:00 /Applications/Codex.app/Contents/MacOS/ChatGPT\n",
    /^(?:codex|chatgpt)$/i,
    now,
  );
  expect(result).toEqual({ alive: true, earliestStartedAt: now - 60_000, pid: 202 });
  expect(processCommandName("/opt/Codex.exe")).toBe("Codex");
});
