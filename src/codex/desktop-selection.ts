import { spawn, type ChildProcess } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createInterface } from "node:readline";
import { createLogger } from "../util/logger.ts";

const log = createLogger("codex-selection");
const POLL_MS = 1_000;
export const LOCAL_SESSION_BY_TITLE_QUERY =
  "SELECT id FROM threads WHERE archived = 0 AND title <> '' AND (title = ? OR title LIKE ? OR ? LIKE title || '%') ORDER BY length(title) DESC, recency_at_ms DESC, updated_at_ms DESC LIMIT 1";

export interface CodexDesktopSelection {
  remote: boolean;
  remotePath?: string;
  sessionId?: string;
  threadTitle?: string;
}

export type CodexUiSelection =
  | { kind: "desktop"; title: string }
  | { kind: "cli"; pid: number };

const WINDOWS_UI_WATCH_SCRIPT = String.raw`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CodexDiscordSelectedWindow {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
$last = ''
while ($true) {
    try {
        $handle = [CodexDiscordSelectedWindow]::GetForegroundWindow()
        [uint32]$foregroundPid = 0
        [void][CodexDiscordSelectedWindow]::GetWindowThreadProcessId($handle, [ref]$foregroundPid)
        $foreground = Get-Process -Id $foregroundPid -ErrorAction Stop
        $message = $null
        $main = Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if ($main) {
            $root = [System.Windows.Automation.AutomationElement]::FromHandle($main.MainWindowHandle)
            $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
            $selected = $null
            $selectedScore = 0
            for ($i = 0; $i -lt $elements.Count; $i++) {
                $element = $elements.Item($i)
                $type = $element.Current.ControlType
                if ($type -ne [System.Windows.Automation.ControlType]::Button -and
                    $type -ne [System.Windows.Automation.ControlType]::ListItem -and
                    $type -ne [System.Windows.Automation.ControlType]::DataItem -and
                    $type -ne [System.Windows.Automation.ControlType]::TabItem) { continue }
                if ([string]::IsNullOrWhiteSpace($element.Current.Name)) { continue }
                $class = $element.Current.ClassName
                $score = 0
                try {
                    $pattern = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
                    if ($pattern.Current.IsSelected) { $score += 100 }
                } catch {}
                if ($class -match '(?:^| )(?:bg-token-list-hover-background|bg-token-list-active-background|bg-token-main-surface-secondary)(?: |$)') { $score += 40 }
                $markers = "$($element.Current.AutomationId) $($element.Current.HelpText) $($element.Current.ItemStatus)"
                if ($markers -match '(?i)\b(?:selected|active|current|checked)\b') { $score += 60 }
                if ($score -gt $selectedScore) {
                    $selected = $element
                    $selectedScore = $score
                }
            }
            if ($selected -and $selectedScore -gt 0) {
                $message = @{ kind = 'desktop'; title = $selected.Current.Name }
            }
        }
        if ($foreground.ProcessName -ine 'ChatGPT') {
            $processes = @(Get-CimInstance Win32_Process)
            $byId = @{}
            foreach ($process in $processes) { $byId[[int]$process.ProcessId] = $process }
            foreach ($candidate in $processes) {
                if ($candidate.Name -ine 'codex.exe' -or [string]$candidate.CommandLine -match '\bapp-server\b') { continue }
                $node = $candidate
                while ($node) {
                    if ([int]$node.ProcessId -eq [int]$foregroundPid) {
                        $message = @{ kind = 'cli'; pid = [int]$candidate.ProcessId }
                        break
                    }
                    $parentId = [int]$node.ParentProcessId
                    if ($parentId -le 0 -or -not $byId.ContainsKey($parentId)) { break }
                    $node = $byId[$parentId]
                }
                if ($message) { break }
            }
        }
        if ($message) {
            $json = ConvertTo-Json -InputObject $message -Compress
            if ($json -ne $last) {
                [Console]::Out.WriteLine($json)
                [Console]::Out.Flush()
                $last = $json
            }
        }
    } catch {}
    Start-Sleep -Milliseconds 750
}
`;

export function parseCodexUiSelection(line: string): CodexUiSelection | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.kind === "cli" && typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0) {
      return { kind: "cli", pid: value.pid };
    }
    if (value.kind === "desktop" && typeof value.title === "string" && value.title.trim() !== "") {
      return { kind: "desktop", title: value.title.trim() };
    }
  } catch {}
  return undefined;
}

function hasOwn(state: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(state, key);
}

function remoteProjectSelection(
  state: Record<string, unknown>,
  projectId: string,
): CodexDesktopSelection {
  const projects = state["remote-projects"];
  if (!Array.isArray(projects)) return { remote: true };
  for (const project of projects) {
    if (!project || typeof project !== "object") continue;
    const entry = project as Record<string, unknown>;
    if (entry.id !== projectId) continue;
    const remotePath = typeof entry.remotePath === "string" ? entry.remotePath.trim() : "";
    return remotePath ? { remote: true, remotePath } : { remote: true };
  }
  return { remote: true };
}

export function parseCodexDesktopSelection(raw: string): CodexDesktopSelection | undefined {
  let state: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    state = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const selectedProject = state["selected-project"];
  if (selectedProject && typeof selectedProject === "object") {
    const selected = selectedProject as Record<string, unknown>;
    if (selected.type === "local") return { remote: false };
    if (selected.type === "remote") {
      const projectId = typeof selected.projectId === "string" ? selected.projectId.trim() : "";
      return projectId ? remoteProjectSelection(state, projectId) : { remote: true };
    }
  }

  if (
    hasOwn(state, "selected-project") ||
    hasOwn(state, "local-projects") ||
    hasOwn(state, "projectless-thread-ids") ||
    hasOwn(state, "thread-project-assignments")
  ) {
    return { remote: false };
  }

  const activeProjectId = state["active-remote-project-id"];
  if (typeof activeProjectId !== "string" || activeProjectId.trim() === "") {
    return { remote: false };
  }
  return remoteProjectSelection(state, activeProjectId);
}

export class CodexDesktopSelectionWatcher {
  private readonly stateFile: string;
  private readonly stateDatabaseFile: string;
  private readonly logsDatabaseFile: string;
  private timer?: ReturnType<typeof setInterval>;
  private reading = false;
  private stopped = false;
  private lastMtime?: number;
  private lastKey?: string;
  private stateRaw?: string;
  private uiSelection?: CodexUiSelection;
  private uiChild?: ChildProcess;

  constructor(codexHome: string, private readonly onUpdate: (selection: CodexDesktopSelection) => void) {
    this.stateFile = join(codexHome, ".codex-global-state.json");
    this.stateDatabaseFile = join(codexHome, "state_5.sqlite");
    this.logsDatabaseFile = join(codexHome, "logs_2.sqlite");
  }

  start(): void {
    void this.scan();
    this.timer = setInterval(() => void this.scan(), POLL_MS);
    if (process.platform === "win32") void this.watchUi();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.uiChild?.kill();
  }

  private async scan(): Promise<void> {
    if (this.stopped || this.reading) return;
    this.reading = true;
    try {
      const info = await stat(this.stateFile);
      if (info.mtimeMs !== this.lastMtime || !this.stateRaw) {
        this.stateRaw = await readFile(this.stateFile, "utf8");
        this.lastMtime = info.mtimeMs;
      }
      const selection = this.resolveSelection(this.stateRaw);
      if (!selection) return;
      this.report(selection);
    } catch (err) {
      log.debug(`selection read failed: ${(err as Error).message}`);
    } finally {
      this.reading = false;
    }
  }

  private report(selection: CodexDesktopSelection): void {
    const key = `${selection.remote}:${selection.remotePath ?? ""}:${selection.sessionId ?? ""}:${selection.threadTitle ?? ""}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    log.debug(`selected ${selection.remote ? "remote" : "local"}${selection.remotePath ? ` path=${selection.remotePath}` : ""}${selection.sessionId ? ` session=${selection.sessionId}` : ""}`);
    this.onUpdate(selection);
  }

  private resolveSelection(raw: string): CodexDesktopSelection | undefined {
    const ui = this.uiSelection;
    if (!ui) return parseCodexDesktopSelection(raw);
    if (ui.kind === "cli") {
      const sessionId = this.sessionIdForProcess(ui.pid);
      return sessionId ? { remote: false, sessionId } : parseCodexDesktopSelection(raw);
    }
    const base = parseCodexDesktopSelection(raw);
    if (base?.remote) return { ...base, threadTitle: ui.title };
    const sessionId = this.localSessionId(ui.title);
    return sessionId ? { remote: false, sessionId } : (base ?? { remote: false });
  }

  private localSessionId(title: string): string | undefined {
    try {
      const database = new DatabaseSync(this.stateDatabaseFile, { readOnly: true });
      try {
        const row = database.prepare(
          LOCAL_SESSION_BY_TITLE_QUERY,
        ).get(title, `${title}%`, title) as { id?: unknown } | undefined;
        return typeof row?.id === "string" ? row.id.toLowerCase() : undefined;
      } finally {
        database.close();
      }
    } catch {
      return undefined;
    }
  }

  private sessionIdForProcess(pid: number): string | undefined {
    try {
      const database = new DatabaseSync(this.logsDatabaseFile, { readOnly: true });
      try {
        const row = database.prepare(
          "SELECT thread_id AS threadId FROM logs WHERE process_uuid LIKE ? AND thread_id IS NOT NULL ORDER BY id DESC LIMIT 1",
        ).get(`pid:${pid}:%`) as { threadId?: unknown } | undefined;
        return typeof row?.threadId === "string" ? row.threadId.toLowerCase() : undefined;
      } finally {
        database.close();
      }
    } catch {
      return undefined;
    }
  }

  private async watchUi(): Promise<void> {
    while (!this.stopped) {
      try {
        const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_UI_WATCH_SCRIPT], {
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
          shell: false,
        });
        this.uiChild = child;
        const exited = new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", () => resolve());
        });
        const output = child.stdout;
        if (!output) throw new Error("UI selection watcher has no stdout");
        const lines = createInterface({ input: output, crlfDelay: Infinity });
        for await (const line of lines) {
          if (this.stopped) break;
          const selection = parseCodexUiSelection(line);
          if (!selection) continue;
          this.uiSelection = selection;
          if (this.stateRaw) {
            const resolved = this.resolveSelection(this.stateRaw);
            if (resolved) this.report(resolved);
          }
        }
        await exited;
      } catch (err) {
        if (!this.stopped) log.debug(`UI selection failed: ${(err as Error).message}`);
      } finally {
        this.uiChild = undefined;
      }
      if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}
