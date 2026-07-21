import { test, expect } from "vitest";
import { codexToolLabel } from "../src/codex/tool-labels.ts";

test("apply_patch shows the edited file", () => {
  expect(codexToolLabel("apply_patch", "config.ts")).toBe("Editing config.ts");
  expect(codexToolLabel("apply_patch")).toBe("Editing files");
});

test("mcp shows the server when known", () => {
  expect(codexToolLabel("mcp", undefined, "github")).toBe("Using github");
  expect(codexToolLabel("mcp")).toBe("Using MCP tools");
});

test("static labels", () => {
  expect(codexToolLabel("shell_command")).toBe("Running a command");
  expect(codexToolLabel("read_files")).toBe("Reading files");
  expect(codexToolLabel("search_files")).toBe("Searching files");
  expect(codexToolLabel("search_content")).toBe("Searching in files");
  expect(codexToolLabel("run_tests")).toBe("Running tests");
  expect(codexToolLabel("check_types")).toBe("Checking types");
  expect(codexToolLabel("build_project")).toBe("Building the project");
  expect(codexToolLabel("web_search")).toBe("Searching the web");
  expect(codexToolLabel("spawn_agent")).toBe("Delegating to agents");
  expect(codexToolLabel("update_plan")).toBe("Updating the plan");
  expect(codexToolLabel("docs")).toBe("Reading docs");
  expect(codexToolLabel("context_compacted")).toBe("Compacting context");
  expect(codexToolLabel("web_run")).toBe("Browsing the web");
  expect(codexToolLabel("browser")).toBe("Using the browser");
  expect(codexToolLabel("send_input")).toBe("Messaging an agent");
  expect(codexToolLabel("load_workspace_dependencies")).toBe("Loading workspace dependencies");
  expect(codexToolLabel("plugin")).toBe("Managing plugins");
  expect(codexToolLabel("open_task")).toBe("Opening a task");
  expect(codexToolLabel("read_terminal")).toBe("Reading the terminal");
  expect(codexToolLabel("computer")).toBe("Controlling the computer");
  expect(codexToolLabel("read_resource", undefined, "github")).toBe("Reading from github");
  expect(codexToolLabel("run_script")).toBe("Running a script");
  expect(codexToolLabel("inspect_files")).toBe("Inspecting files");
  expect(codexToolLabel("weather")).toBe("Checking the weather");
  expect(codexToolLabel("inspect_logs")).toBe("Inspecting system logs");
  expect(codexToolLabel("inspect_github")).toBe("Inspecting GitHub");
});

test("unknown label falls back to Working", () => {
  expect(codexToolLabel("generic")).toBe("Working");
  expect(codexToolLabel("something-else")).toBe("Working");
});
