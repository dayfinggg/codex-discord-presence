import { test, expect } from "vitest";
import { parseRolloutLine, sessionIdFromPath } from "../src/codex/rollout-parser.ts";

test("session_meta for a user session", () => {
  const line =
    '{"timestamp":"2025-01-02T03:04:05.000Z","type":"session_meta","payload":{"session_id":"user-session","id":"user-session","cwd":"C:\\\\Users\\\\example","originator":"codex-tui","source":"cli","thread_source":"user","model_provider":"openai"}}';
  const event = parseRolloutLine(line);
  expect(event).toEqual({
    kind: "session_meta",
    cwd: "C:\\Users\\example",
    source: "cli",
    isSubagent: false,
    parentThreadId: undefined,
    agentRole: undefined,
  });
});

test("session_meta for a subagent carries parent thread id", () => {
  const line =
    '{"type":"session_meta","payload":{"id":"subagent-session","cwd":"D:\\\\example","source":{"subagent":{"thread_spawn":{"parent_thread_id":"PARENT-THREAD","depth":1,"agent_role":"explorer"}}},"thread_source":"subagent","agent_role":"explorer"}}';
  const event = parseRolloutLine(line);
  expect(event).toMatchObject({
    kind: "session_meta",
    isSubagent: true,
    parentThreadId: "parent-thread",
    agentRole: "explorer",
  });
});

test("turn_context extracts model, effort, plan mode and service tier", () => {
  const line =
    '{"type":"turn_context","payload":{"model":"gpt-5.5","effort":"xhigh","service_tier":"priority","collaboration_mode":{"mode":"plan"}}}';
  expect(parseRolloutLine(line)).toEqual({
    kind: "turn_context",
    model: "gpt-5.5",
    effort: "xhigh",
    planMode: true,
    realtime: false,
    serviceTier: "priority",
  });
});

test("turn_context flags realtime mode", () => {
  const line =
    '{"type":"turn_context","payload":{"model":"gpt-5.5","effort":"high","realtime_active":true,"collaboration_mode":{"mode":"default"}}}';
  expect(parseRolloutLine(line)).toMatchObject({ realtime: true, planMode: false });
});

test("a null service tier is preserved as a cleared override", () => {
  const line =
    '{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"service_tier":null}}}';
  expect(parseRolloutLine(line)).toMatchObject({ kind: "thread_settings", serviceTier: null });
});

test("turn_context falls back to collaboration_mode settings effort", () => {
  const line =
    '{"type":"turn_context","payload":{"model":"gpt-5.5","collaboration_mode":{"mode":"default","settings":{"reasoning_effort":"high"}}}}';
  expect(parseRolloutLine(line)).toMatchObject({ effort: "high", planMode: false });
});

test("token_count parses usage, context and rate limits", () => {
  const line =
    '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":12378,"cached_input_tokens":5504,"output_tokens":178,"reasoning_output_tokens":171,"total_tokens":12556},"last_token_usage":{"total_tokens":12556},"model_context_window":258400},"rate_limits":{"primary":{"used_percent":2,"window_minutes":300,"resets_at":1783521774},"secondary":{"used_percent":9,"window_minutes":10080,"resets_at":1784000170},"plan_type":"pro"}}}';
  const event = parseRolloutLine(line);
  expect(event).toEqual({
    kind: "token_count",
    usage: { input: 12378, cachedInput: 5504, output: 178, reasoning: 171, total: 12556 },
    contextWindow: 258400,
    contextUsed: 12556,
    limits: {
      primary: { usedPercent: 2, windowMinutes: 300, resetsAt: 1783521774 },
      secondary: { usedPercent: 9, windowMinutes: 10080, resetsAt: 1784000170 },
    },
    planType: "pro",
  });
});

test("token_count with null rate_limits yields no limits", () => {
  const line =
    '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}},"rate_limits":null}}';
  expect(parseRolloutLine(line)).toMatchObject({ limits: undefined, planType: undefined });
});

test("function_call shell_command classifies its command", () => {
  const line =
    '{"type":"response_item","payload":{"type":"function_call","name":"shell_command","arguments":"{\\"command\\":\\"Get-Content src/index.ts\\"}"}}';
  expect(parseRolloutLine(line)).toEqual({ kind: "tool", name: "read_files" });
});

test("custom_tool_call apply_patch extracts basename", () => {
  const line =
    '{"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","input":"*** Begin Patch\\n*** Update File: C:/Users/example/project/operating-policy.md\\n@@"}}';
  expect(parseRolloutLine(line)).toEqual({ kind: "tool", name: "apply_patch", file: "operating-policy.md" });
});

test("custom_tool_call exec classifies by the wrapped tool", () => {
  const shell =
    '{"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"const r = await tools.shell_command({command: \\"Get-ChildItem -Recurse\\"});"}}';
  expect(parseRolloutLine(shell)).toEqual({ kind: "tool", name: "search_files" });

  const web =
    '{"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"await tools.web__run({query: \\"docs\\"});"}}';
  expect(parseRolloutLine(web)).toEqual({ kind: "tool", name: "web_run" });

  const js =
    '{"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"const x = 1 + 1; return x;"}}';
  expect(parseRolloutLine(js)).toEqual({ kind: "tool", name: "js" });
});

test("custom_tool_call exec preserves wrapped tool semantics", () => {
  const cases = [
    ["update_plan", "update_plan"],
    ["view_image", "view_image"],
    ["request_plugin_install", "plugin"],
    ["codex_app__load_workspace_dependencies", "load_workspace_dependencies"],
    ["codex_app__navigate_to_codex_page", "open_task"],
    ["codex_app__list_threads", "list_tasks"],
    ["chrome_extension__getTabContext", "inspect_browser"],
    ["mcp__node_repl__js", "js"],
    ["image_gen__imagegen", "image_generation"],
  ] as const;

  for (const [wrappedName, expectedName] of cases) {
    const line = JSON.stringify({
      type: "response_item",
      payload: { type: "custom_tool_call", name: "exec", input: `await tools.${wrappedName}({});` },
    });
    expect(parseRolloutLine(line)).toEqual({ kind: "tool", name: expectedName });
  }

  const mcp = JSON.stringify({
    type: "response_item",
    payload: { type: "custom_tool_call", name: "exec", input: "await tools.mcp__github__get_issue({});" },
  });
  expect(parseRolloutLine(mcp)).toEqual({ kind: "tool", name: "mcp", server: "github" });
});

test("wrapped shell commands retain read, search and verification actions", () => {
  const cases = [
    ["Get-Content -Raw src/index.ts", "read_files"],
    ["rg -n 'token' src", "search_content"],
    ["Get-ChildItem -Recurse -Filter *.ts", "search_files"],
    ["bun test", "run_tests"],
    ["bun run typecheck", "check_types"],
    ["bun run build", "build_project"],
  ] as const;
  for (const [command, expectedName] of cases) {
    const line = JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        input: `const r = await tools.shell_command({ command: ${JSON.stringify(command)} }); text(r);`,
      },
    });
    expect(parseRolloutLine(line)).toEqual({ kind: "tool", name: expectedName });
  }
});

test("remote unified exec commands use the cmd property", () => {
  const line = JSON.stringify({
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      input: 'const r = await tools.exec_command({ cmd: "sed -n \'1,180p\' src/index.ts" }); text(r);',
    },
  });
  expect(parseRolloutLine(line)).toEqual({ kind: "tool", name: "read_files" });
});

test("custom_tool_call exec uses the first wrapped call for parallel batches", () => {
  const line = JSON.stringify({
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name: "exec",
      input: "await Promise.all([tools.shell_command({}), tools.view_image({})]);",
    },
  });
  expect(parseRolloutLine(line)).toEqual({ kind: "tool", name: "shell_command" });
});

test("custom_tool_call exec with apply_patch extracts the escaped file name", () => {
  const line =
    '{"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"const patch = \\"*** Begin Patch\\\\n*** Update File: C:\\\\\\\\Users\\\\\\\\example\\\\\\\\.codex\\\\\\\\model-instructions.md\\\\n+line\\\\n*** End Patch\\";\\nawait tools.apply_patch({input: patch});"}}';
  expect(parseRolloutLine(line)).toEqual({
    kind: "tool",
    name: "apply_patch",
    file: "model-instructions.md",
  });
});

test("wait on a running exec cell shows a waiting label", () => {
  const line =
    '{"type":"response_item","payload":{"type":"function_call","name":"wait","arguments":"{\\"cell_id\\":\\"14\\",\\"yield_time_ms\\":1000}"}}';
  expect(parseRolloutLine(line)).toEqual({ kind: "tool", name: "shell_wait" });
});

test("template-literal patch targets fall back to a generic edit label", () => {
  const line =
    '{"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"const patch = `*** Begin Patch\\\\n*** Update File: ${path}\\\\n+x\\\\n*** End Patch`;\\nawait tools.apply_patch({input: patch});"}}';
  expect(parseRolloutLine(line)).toEqual({ kind: "tool", name: "apply_patch", file: undefined });
});

test("workspace, plugin, agent-input and mcp-resource calls get their own tools", () => {
  const deps =
    '{"type":"response_item","payload":{"type":"function_call","name":"load_workspace_dependencies","arguments":"{}"}}';
  expect(parseRolloutLine(deps)).toEqual({ kind: "tool", name: "load_workspace_dependencies" });

  const input =
    '{"type":"response_item","payload":{"type":"function_call","name":"send_input","arguments":"{\\"target\\":\\"agent-01\\",\\"message\\":\\"synthetic message\\"}"}}';
  expect(parseRolloutLine(input)).toEqual({ kind: "tool", name: "message_agent" });

  const plugin =
    '{"type":"response_item","payload":{"type":"function_call","name":"request_plugin_install","arguments":"{}"}}';
  expect(parseRolloutLine(plugin)).toEqual({ kind: "tool", name: "plugin" });

  const resource =
    '{"type":"response_item","payload":{"type":"function_call","name":"read_mcp_resource","arguments":"{\\"server\\":\\"github\\",\\"uri\\":\\"x\\"}"}}';
  expect(parseRolloutLine(resource)).toEqual({ kind: "tool", name: "read_resource", server: "github" });
});

test("available task, agent and documentation actions have distinct events", () => {
  const cases = [
    ["fetch_openai_doc", "docs_read"],
    ["search_openai_docs", "docs_search"],
    ["list_openai_docs", "docs_list"],
    ["list_agents", "list_agents"],
    ["send_message", "message_agent"],
    ["followup_task", "followup_agent"],
    ["list_projects", "list_projects"],
    ["list_threads", "list_tasks"],
    ["read_thread", "read_task"],
    ["create_thread", "create_task"],
    ["fork_thread", "fork_task"],
    ["send_message_to_thread", "message_task"],
    ["read_thread_terminal", "read_terminal"],
  ] as const;
  for (const [name, expectedName] of cases) {
    const line = JSON.stringify({
      type: "response_item",
      payload: { type: "function_call", name, arguments: "{}" },
    });
    expect(parseRolloutLine(line)).toEqual({ kind: "tool", name: expectedName });
  }
});

test("mcp completion preserves known documentation actions", () => {
  const line = JSON.stringify({
    type: "event_msg",
    payload: {
      type: "mcp_tool_call_end",
      invocation: { server: "openaiDeveloperDocs", tool: "search_openai_docs", arguments: { query: "Codex" } },
    },
  });
  expect(parseRolloutLine(line)).toEqual({ kind: "tool", name: "docs_search" });
});

test("wrapped web actions preserve the requested data type", () => {
  const cases = [
    ["search_query", "web_search"],
    ["image_query", "image_search"],
    ["weather", "weather"],
    ["finance", "finance"],
    ["sports", "sports"],
    ["time", "time_lookup"],
  ] as const;
  for (const [property, expectedName] of cases) {
    const line = JSON.stringify({
      type: "response_item",
      payload: { type: "custom_tool_call", name: "exec", input: `await tools.web__run({ ${property}: [] });` },
    });
    expect(parseRolloutLine(line)).toEqual({ kind: "tool", name: expectedName });
  }
});

test("thread_settings_applied carries the new model, effort and service tier", () => {
  const line =
    '{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"gpt-5.6-sol","reasoning_effort":"ultra","service_tier":"priority","collaboration_mode":{"mode":"default","settings":{"model":"gpt-5.6-sol","reasoning_effort":"ultra"}}}}}';
  expect(parseRolloutLine(line)).toEqual({
    kind: "thread_settings",
    model: "gpt-5.6-sol",
    effort: "ultra",
    planMode: false,
    serviceTier: "priority",
  });
});

test("patch_apply_end extracts basename from changes", () => {
  const line =
    '{"type":"event_msg","payload":{"type":"patch_apply_end","changes":{"C:\\\\Users\\\\example\\\\project\\\\settings.json":{"type":"update"}}}}';
  expect(parseRolloutLine(line)).toEqual({ kind: "tool", name: "apply_patch", file: "settings.json" });
});

test("spawn and close agents", () => {
  const spawn = '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","arguments":"{}"}}';
  expect(parseRolloutLine(spawn)).toEqual({ kind: "tool", name: "spawn_agent" });
  const close =
    '{"type":"response_item","payload":{"type":"function_call","name":"close_agent","arguments":"{\\"target\\":\\"agent-02\\"}"}}';
  expect(parseRolloutLine(close)).toEqual({ kind: "agent_close", targets: ["agent-02"] });
});

test("request_user_input becomes its own event", () => {
  const line =
    '{"type":"response_item","payload":{"type":"function_call","name":"request_user_input","arguments":"{}"}}';
  expect(parseRolloutLine(line)).toEqual({ kind: "request_user_input" });
});

test("task boundaries", () => {
  expect(
    parseRolloutLine('{"type":"event_msg","payload":{"type":"task_started","model_context_window":258400}}'),
  ).toEqual({ kind: "task_started", contextWindow: 258400 });
  expect(parseRolloutLine('{"type":"event_msg","payload":{"type":"task_complete"}}')).toEqual({ kind: "turn_ended" });
  expect(parseRolloutLine('{"type":"event_msg","payload":{"type":"turn_aborted"}}')).toEqual({ kind: "turn_ended" });
});

test("unknown and malformed lines are ignored", () => {
  expect(parseRolloutLine('{"type":"response_item","payload":{"type":"message","role":"user"}}')).toBeUndefined();
  expect(parseRolloutLine("not json")).toBeUndefined();
  expect(parseRolloutLine("")).toBeUndefined();
});

test("sessionIdFromPath pulls uuid from rollout filename", () => {
  const path =
    "C:/Users/example/.codex/sessions/2025/01/02/rollout-2025-01-02T03-04-05-55555555-5555-4555-8555-555555555555.jsonl";
  expect(sessionIdFromPath(path)).toBe("55555555-5555-4555-8555-555555555555");
  expect(sessionIdFromPath("nope.jsonl")).toBeUndefined();
});
