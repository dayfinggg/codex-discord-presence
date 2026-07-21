import { expect, test } from "vitest";
import { classifyShellCommand } from "../src/codex/shell-action.ts";

test("classifies file reading and both kinds of search", () => {
  expect(classifyShellCommand("Get-Content -Raw src/index.ts")).toBe("read_files");
  expect(classifyShellCommand("Get-ChildItem -Recurse -Filter *.ts")).toBe("search_files");
  expect(classifyShellCommand("rg -n 'token' src")).toBe("search_content");
  expect(classifyShellCommand("find . -name '*.ts'")).toBe("search_files");
  expect(classifyShellCommand("cat package.json")).toBe("read_files");
});

test("uses the first file operation in compound inspection commands", () => {
  expect(classifyShellCommand("Get-Content fixtures/synthetic-input.txt; Get-ChildItem fixtures")).toBe("read_files");
  expect(classifyShellCommand("Get-ChildItem fixtures; Get-Content fixtures/synthetic-input.txt")).toBe("search_files");
});

test("classifies development commands before incidental file operations", () => {
  expect(classifyShellCommand("Get-Content fixtures/synthetic-input.txt; bun test")).toBe("run_tests");
  expect(classifyShellCommand("bun run typecheck")).toBe("check_types");
  expect(classifyShellCommand("bun run build")).toBe("build_project");
  expect(classifyShellCommand("npm run lint")).toBe("run_lint");
  expect(classifyShellCommand("pnpm install")).toBe("install_dependencies");
});

test("classifies operational and repository commands", () => {
  expect(classifyShellCommand("git blame synthetic-file.txt")).toBe("inspect_git");
  expect(classifyShellCommand("git commit -m fix")).toBe("manage_git");
  expect(classifyShellCommand("Get-CimInstance Win32_Process")).toBe("inspect_processes");
  expect(classifyShellCommand("Stop-Process -Id 1; Start-Process bun src/index.ts")).toBe("restart_service");
  expect(classifyShellCommand("Get-NetTCPConnection -State Listen")).toBe("network_request");
  expect(classifyShellCommand("Start-Sleep -Seconds 2")).toBe("shell_wait");
});

test("keeps unknown shell commands generic", () => {
  expect(classifyShellCommand("codex synthetic-subcommand")).toBe("inspect_codex");
  expect(classifyShellCommand("echo ready")).toBe("shell_command");
  expect(classifyShellCommand(undefined)).toBe("shell_command");
});

test("classifies scripts, remote commands and inspections", () => {
  expect(classifyShellCommand("python scripts/validate.py")).toBe("run_script");
  expect(classifyShellCommand("node scripts/read-config.mjs")).toBe("run_script");
  expect(classifyShellCommand("ssh host.example pwd")).toBe("remote_connection");
  expect(classifyShellCommand("scp build.zip host.example:/tmp/")).toBe("transfer_files");
  expect(classifyShellCommand("npm view typescript version")).toBe("inspect_packages");
  expect(classifyShellCommand("Get-FileHash package.json")).toBe("inspect_files");
  expect(classifyShellCommand("ConvertFrom-Json $raw")).toBe("process_data");
  expect(classifyShellCommand("Get-ChildItem Env:")).toBe("inspect_environment");
  expect(classifyShellCommand("Get-WinEvent -LogName System")).toBe("inspect_logs");
  expect(classifyShellCommand("reg query HKLM\\Software /s")).toBe("inspect_registry");
  expect(classifyShellCommand("Get-PhysicalDisk")).toBe("inspect_storage");
  expect(classifyShellCommand("ping -n 4 example.com")).toBe("network_request");
  expect(classifyShellCommand("gh repo view owner/repo")).toBe("inspect_github");
  expect(classifyShellCommand("node --check scripts/app.js")).toBe("check_syntax");
});
