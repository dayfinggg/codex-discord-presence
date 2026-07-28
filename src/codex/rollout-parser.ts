import { classifyShellCommand } from "./shell-action.ts";

export interface CodexUsage {
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
  total: number;
}

export interface CodexRateWindow {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: number;
}

export interface CodexRateLimits {
  primary?: CodexRateWindow;
  secondary?: CodexRateWindow;
}

export type CodexEvent =
  | {
      kind: "session_meta";
      cwd?: string;
      source?: string;
      isSubagent: boolean;
      parentThreadId?: string;
      agentRole?: string;
    }
  | {
      kind: "turn_context";
      model?: string;
      effort?: string;
      planMode: boolean;
      realtime: boolean;
      serviceTier?: string | null;
    }
  | { kind: "thread_settings"; model?: string; effort?: string; planMode?: boolean; serviceTier?: string | null }
  | { kind: "task_started"; contextWindow?: number }
  | { kind: "turn_ended" }
  | { kind: "user_message" }
  | {
      kind: "token_count";
      usage: CodexUsage;
      contextWindow?: number;
      contextUsed?: number;
      limits?: CodexRateLimits;
      planType?: string;
    }
  | { kind: "tool"; name: string; file?: string; server?: string }
  | { kind: "reasoning" }
  | { kind: "request_user_input" }
  | { kind: "agent_close"; targets: string[] };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function basename(input: unknown): string | undefined {
  const path = str(input);
  if (!path) return undefined;
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const segment = normalized.slice(normalized.lastIndexOf("/") + 1);
  return segment === "" ? undefined : segment;
}

const PATCH_FILE_RE = /\*\*\* (?:Add|Update|Delete|Move) File: (.+)/;

function fileFromPatch(input: unknown): string | undefined {
  const text = str(input);
  if (!text) return undefined;
  const match = PATCH_FILE_RE.exec(text);
  if (!match) return undefined;
  const target = match[1]!.trim();
  if (target.includes("${")) return undefined;
  return basename(target);
}

function stringProperty(input: string, property: string, from: number): string | undefined {
  const tail = input.slice(from);
  const match = new RegExp(`\\b${property}\\s*:\\s*`).exec(tail);
  if (!match) return undefined;
  const start = from + match.index + match[0].length;
  const quote = input[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
  let value = "";
  for (let index = start + 1; index < input.length; index += 1) {
    const char = input[index]!;
    if (char === quote) return value;
    if (char !== "\\") {
      value += char;
      continue;
    }
    const escaped = input[index + 1];
    if (escaped === undefined) return value;
    index += 1;
    if (escaped === "n") value += "\n";
    else if (escaped === "r") value += "\r";
    else if (escaped === "t") value += "\t";
    else value += escaped;
  }
  return value;
}

function mcpEvent(name: string): CodexEvent {
  const parts = name.split("__");
  const server = parts.length > 2 ? parts[1] : undefined;
  const tool = parts.slice(2).join("__");
  if (server === "codex_apps" && tool.startsWith("sites_")) {
    if (tool.includes("deploy")) return { kind: "tool", name: "deploy_site" };
    if (/^sites_(?:get|list|refresh)/.test(tool)) return { kind: "tool", name: "inspect_sites" };
    return { kind: "tool", name: "manage_site" };
  }
  if (server === "codex_apps" && tool.includes("document_control")) {
    return { kind: "tool", name: tool.includes("execute") ? "edit_documents" : "inspect_documents" };
  }
  return { kind: "tool", name: "mcp", server };
}

function parseWrappedTool(name: string, args: Record<string, unknown>, source: string): CodexEvent {
  if (name === "web__run") {
    if (/\bimage_query\s*:/.test(source)) return { kind: "tool", name: "image_search" };
    if (/\bweather\s*:/.test(source)) return { kind: "tool", name: "weather" };
    if (/\bfinance\s*:/.test(source)) return { kind: "tool", name: "finance" };
    if (/\bsports\s*:/.test(source)) return { kind: "tool", name: "sports" };
    if (/\btime\s*:/.test(source)) return { kind: "tool", name: "time_lookup" };
    if (/\bsearch_query\s*:/.test(source)) return { kind: "tool", name: "web_search" };
    return { kind: "tool", name: "web_run" };
  }
  if (name === "image_gen__imagegen") return { kind: "tool", name: "image_generation" };
  if (name.startsWith("codex_app__")) {
    return parseFunctionCall(name.slice("codex_app__".length), args) ?? { kind: "tool", name: "generic" };
  }
  if (name.startsWith("chrome_extension__")) {
    return { kind: "tool", name: /__(?:get|list|screenshot)/i.test(name) ? "inspect_browser" : "browser" };
  }
  if (name.startsWith("mcp__node_repl__")) {
    if (/(?:setupComputerUseRuntime|computerUse|computer[-_ ]use)/i.test(source)) {
      return { kind: "tool", name: "computer" };
    }
    if (/playwright|chromium|browser/i.test(source)) return { kind: "tool", name: "browser" };
    if (name.endsWith("js_add_node_module_dir")) return { kind: "tool", name: "load_workspace_dependencies" };
    return { kind: "tool", name: "js" };
  }
  if (name.startsWith("mcp__")) return mcpEvent(name);
  return parseFunctionCall(name, args) ?? { kind: "tool", name: "generic" };
}

function parseExec(input: unknown): CodexEvent {
  const text = str(input) ?? "";
  const nestedCall = /\btools\.([A-Za-z_$][\w$]*)\s*\(/g.exec(text);
  const name = nestedCall?.[1];
  if (!name || nestedCall.index === undefined) return { kind: "tool", name: "js" };
  if (name === "apply_patch") {
    const unescaped = text.replace(/\\(.)/g, (_, ch: string) => (ch === "n" ? "\n" : ch === "t" ? "\t" : ch));
    return { kind: "tool", name: "apply_patch", file: fileFromPatch(unescaped) };
  }
  const args: Record<string, unknown> = {};
  const command = stringProperty(text, "command", nestedCall.index) ?? stringProperty(text, "cmd", nestedCall.index);
  const code = stringProperty(text, "code", nestedCall.index);
  if (command !== undefined) args.command = command;
  if (code !== undefined) args.code = code;
  return parseWrappedTool(name, args, code ?? text.slice(nestedCall.index));
}

function firstKey(value: unknown): string | undefined {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) return key;
  }
  return undefined;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function rateWindow(value: unknown): CodexRateWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const usedPercent = optNum(obj.used_percent);
  if (usedPercent === undefined) return undefined;
  return {
    usedPercent,
    windowMinutes: optNum(obj.window_minutes),
    resetsAt: optNum(obj.resets_at),
  };
}

function parseFunctionCall(name: string, args: Record<string, unknown>): CodexEvent | undefined {
  switch (name) {
    case "shell_command":
    case "exec_command":
      return { kind: "tool", name: classifyShellCommand(str(args.command) ?? str(args.cmd)) };
    case "wait":
    case "write_stdin":
      return { kind: "tool", name: "shell_wait" };
    case "apply_patch":
      return { kind: "tool", name: "apply_patch", file: fileFromPatch(args.input ?? args.patch) };
    case "update_plan":
      return { kind: "tool", name: "update_plan" };
    case "js":
      if (/(?:setupComputerUseRuntime|computerUse|computer[-_ ]use)/i.test(str(args.code) ?? "")) {
        return { kind: "tool", name: "computer" };
      }
      return { kind: "tool", name: "js" };
    case "js_reset":
      return { kind: "tool", name: "js" };
    case "view_image":
      return { kind: "tool", name: "view_image" };
    case "fetch_openai_doc":
      return { kind: "tool", name: "docs_read" };
    case "search_openai_docs":
      return { kind: "tool", name: "docs_search" };
    case "list_openai_docs":
      return { kind: "tool", name: "docs_list" };
    case "spawn_agent":
      return { kind: "tool", name: "spawn_agent" };
    case "list_agents":
      return { kind: "tool", name: "list_agents" };
    case "wait_agent":
      return { kind: "tool", name: "wait_agent" };
    case "send_message":
    case "send_input":
      return { kind: "tool", name: "message_agent" };
    case "followup_task":
      return { kind: "tool", name: "followup_agent" };
    case "close_agent": {
      const target = str(args.target);
      const targets = Array.isArray(args.targets)
        ? (args.targets.filter((t) => typeof t === "string") as string[])
        : [];
      if (target) targets.push(target);
      return { kind: "agent_close", targets };
    }
    case "create_goal":
    case "update_goal":
    case "get_goal":
      return { kind: "tool", name: "goal" };
    case "request_user_input":
      return { kind: "request_user_input" };
    case "load_workspace_dependencies":
      return { kind: "tool", name: "load_workspace_dependencies" };
    case "request_plugin_install":
    case "list_available_plugins_to_install":
      return { kind: "tool", name: "plugin" };
    case "read_mcp_resource":
      return { kind: "tool", name: "read_resource", server: str(args.server) };
    case "list_mcp_resources":
    case "list_mcp_resource_templates":
      return { kind: "tool", name: "list_resources" };
    case "list_projects":
      return { kind: "tool", name: "list_projects" };
    case "list_threads":
      return { kind: "tool", name: "list_tasks" };
    case "read_thread":
      return { kind: "tool", name: "read_task" };
    case "create_thread":
      return { kind: "tool", name: "create_task" };
    case "fork_thread":
      return { kind: "tool", name: "fork_task" };
    case "send_message_to_thread":
      return { kind: "tool", name: "message_task" };
    case "handoff_thread":
      return { kind: "tool", name: "handoff_task" };
    case "get_handoff_status":
      return { kind: "tool", name: "check_handoff" };
    case "set_thread_pinned":
    case "set_thread_archived":
    case "set_thread_title":
      return { kind: "tool", name: "manage_task" };
    case "navigate_to_codex_page":
      return { kind: "tool", name: "open_task" };
    case "read_thread_terminal":
      return { kind: "tool", name: "read_terminal" };
    case "automation_update":
      return { kind: "tool", name: "automation" };
    default:
      if (name.startsWith("mcp__")) return mcpEvent(name);
      if (name.includes("__")) return { kind: "tool", name: "mcp" };
      return { kind: "tool", name: "generic" };
  }
}

function parseResponseItem(payload: Record<string, unknown>): CodexEvent | undefined {
  const type = str(payload.type);
  switch (type) {
    case "function_call":
      return parseFunctionCall(str(payload.name) ?? "", parseArgs(payload.arguments));
    case "custom_tool_call": {
      const name = str(payload.name);
      if (name === "apply_patch") {
        return { kind: "tool", name: "apply_patch", file: fileFromPatch(payload.input) };
      }
      if (name === "exec") return parseExec(payload.input);
      return { kind: "tool", name: "generic" };
    }
    case "web_search_call":
      return { kind: "tool", name: "web_search" };
    case "reasoning":
      return { kind: "reasoning" };
    default:
      return undefined;
  }
}

function parseEventMsg(payload: Record<string, unknown>): CodexEvent | undefined {
  const type = str(payload.type);
  switch (type) {
    case "task_started":
      return { kind: "task_started", contextWindow: optNum(payload.model_context_window) };
    case "task_complete":
    case "turn_aborted":
      return { kind: "turn_ended" };
    case "user_message":
      return { kind: "user_message" };
    case "token_count": {
      const info = (payload.info ?? {}) as Record<string, unknown>;
      const total = (info.total_token_usage ?? {}) as Record<string, unknown>;
      const last = (info.last_token_usage ?? {}) as Record<string, unknown>;
      const usage: CodexUsage = {
        input: num(total.input_tokens),
        cachedInput: num(total.cached_input_tokens),
        output: num(total.output_tokens),
        reasoning: num(total.reasoning_output_tokens),
        total: num(total.total_tokens),
      };
      const rl = payload.rate_limits as Record<string, unknown> | null | undefined;
      let limits: CodexRateLimits | undefined;
      if (rl && typeof rl === "object") {
        const primary = rateWindow(rl.primary);
        const secondary = rateWindow(rl.secondary);
        if (primary || secondary) limits = { primary, secondary };
      }
      return {
        kind: "token_count",
        usage,
        contextWindow: optNum(info.model_context_window),
        contextUsed: optNum(last.total_tokens),
        limits,
        planType: str(rl?.plan_type),
      };
    }
    case "patch_apply_end":
      return { kind: "tool", name: "apply_patch", file: basename(firstKey(payload.changes)) };
    case "web_search_end":
      return { kind: "tool", name: "web_search" };
    case "mcp_tool_call_end": {
      const invocation = (payload.invocation ?? {}) as Record<string, unknown>;
      const server = str(invocation.server);
      const tool = str(invocation.tool);
      if (tool) {
        const event = parseFunctionCall(tool, (invocation.arguments ?? {}) as Record<string, unknown>);
        if (event && (event.kind !== "tool" || (event.name !== "generic" && event.name !== "mcp"))) return event;
      }
      return { kind: "tool", name: "mcp", server };
    }
    case "image_generation_end":
      return { kind: "tool", name: "image_generation" };
    case "context_compacted":
      return { kind: "tool", name: "context_compacted" };
    case "thread_settings_applied": {
      const settings = (payload.thread_settings ?? {}) as Record<string, unknown>;
      const mode = (settings.collaboration_mode ?? {}) as Record<string, unknown>;
      const modeSettings = (mode.settings ?? {}) as Record<string, unknown>;
      const modeName = str(mode.mode);
      return {
        kind: "thread_settings",
        model: str(settings.model) ?? str(modeSettings.model),
        effort: str(settings.reasoning_effort) ?? str(modeSettings.reasoning_effort),
        planMode: modeName === undefined ? undefined : modeName === "plan",
        serviceTier: settings.service_tier === null ? null : str(settings.service_tier),
      };
    }
    default:
      return undefined;
  }
}

function parseSessionMeta(payload: Record<string, unknown>): CodexEvent {
  const source = payload.source;
  let sourceLabel: string | undefined;
  let parentThreadId: string | undefined;
  let isSubagent = false;

  if (typeof source === "string") {
    sourceLabel = source;
  } else if (source && typeof source === "object") {
    const spawn = (source as Record<string, unknown>).subagent as Record<string, unknown> | undefined;
    const threadSpawn = spawn?.thread_spawn as Record<string, unknown> | undefined;
    if (threadSpawn) {
      isSubagent = true;
      parentThreadId = str(threadSpawn.parent_thread_id)?.toLowerCase();
    }
  }

  return {
    kind: "session_meta",
    cwd: str(payload.cwd),
    source: sourceLabel,
    isSubagent,
    parentThreadId,
    agentRole: str(payload.agent_role),
  };
}

function eventFromRecord(record: Record<string, unknown>): CodexEvent | undefined {
  const type = str(record.type);
  const payload = (record.payload ?? {}) as Record<string, unknown>;

  switch (type) {
    case "session_meta":
      return parseSessionMeta(payload);
    case "turn_context": {
      const mode = (payload.collaboration_mode ?? {}) as Record<string, unknown>;
      const settings = (mode.settings ?? {}) as Record<string, unknown>;
      return {
        kind: "turn_context",
        model: str(payload.model),
        effort: str(payload.effort) ?? str(settings.reasoning_effort),
        planMode: str(mode.mode) === "plan",
        realtime: payload.realtime_active === true,
        serviceTier: payload.service_tier === null ? null : str(payload.service_tier),
      };
    }
    case "event_msg":
      return parseEventMsg(payload);
    case "response_item":
      return parseResponseItem(payload);
    default:
      return undefined;
  }
}

export interface ParsedRollout {
  event: CodexEvent;
  at?: number;
}

export function parseRollout(line: string): ParsedRollout | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  let record: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    record = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const event = eventFromRecord(record);
  if (!event) return undefined;

  const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
  return { event, at: Number.isFinite(at) ? at : undefined };
}

export function parseRolloutLine(line: string): CodexEvent | undefined {
  return parseRollout(line)?.event;
}

export function sessionIdFromPath(path: string): string | undefined {
  const match = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/.exec(
    path,
  );
  return match ? match[1]!.toLowerCase() : undefined;
}
