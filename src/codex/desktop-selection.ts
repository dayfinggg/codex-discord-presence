import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLogger } from "../util/logger.ts";

const log = createLogger("codex-selection");
const POLL_MS = 1_000;
const UI_POLL_MS = 2_000;

export interface LocalSessionTitleCandidate {
  id: string;
  title: string;
  cwd: string;
}

export interface CodexDesktopSelection {
  remote: boolean;
  remotePath?: string;
  sessionId?: string;
  threadTitle?: string;
  model?: string;
  effort?: string;
}

export type CodexUiSelection =
  | { kind: "desktop"; title: string; model?: string; effort?: string }
  | { kind: "cli"; pid: number };

export const WINDOWS_UI_WATCH_SCRIPT = String.raw`
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
        if ($foreground.ProcessName -ieq 'ChatGPT') {
            $main = Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
            if ($main) {
                $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
                $controlType = [System.Windows.Automation.AutomationElement]::ControlTypeProperty
                $conditions = [System.Windows.Automation.Condition[]]@(
                    [System.Windows.Automation.PropertyCondition]::new($controlType, [System.Windows.Automation.ControlType]::Button),
                    [System.Windows.Automation.PropertyCondition]::new($controlType, [System.Windows.Automation.ControlType]::ListItem),
                    [System.Windows.Automation.PropertyCondition]::new($controlType, [System.Windows.Automation.ControlType]::DataItem),
                    [System.Windows.Automation.PropertyCondition]::new($controlType, [System.Windows.Automation.ControlType]::TabItem)
                )
                $elements = $root.FindAll(
                    [System.Windows.Automation.TreeScope]::Descendants,
                    [System.Windows.Automation.OrCondition]::new($conditions)
                )
                $selected = $null
                $selectedScore = 0
                $modelLabel = $null
                for ($i = 0; $i -lt $elements.Count; $i++) {
                    $element = $elements.Item($i)
                    $current = $element.Current
                    if ($current.IsOffscreen -or [string]::IsNullOrWhiteSpace($current.Name)) { continue }
                    $class = $current.ClassName
                    if ($current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
                        $class -match 'max-w-\[320px\]') {
                        $selected = $element
                        $selectedScore = 1000
                    }
                    if ($current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
                        $class -match 'h-token-button-composer' -and
                        $current.Name -match '^(?:GPT[-\s]*)?\d+(?:\.\d+)*(?:\s|$)') {
                        $modelLabel = $current.Name
                    }
                }
                if (-not $selected) {
                  for ($i = 0; $i -lt $elements.Count; $i++) {
                    $element = $elements.Item($i)
                    $current = $element.Current
                    if ($current.IsOffscreen -or [string]::IsNullOrWhiteSpace($current.Name)) { continue }
                    $class = $current.ClassName
                    $score = 0
                    try {
                        $pattern = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
                        if ($pattern.Current.IsSelected) { $score += 100 }
                    } catch {}
                    if ($class -match '(?:^| )bg-token-list-active-background(?: |$)') { $score += 40 }
                    $markers = "$($current.AutomationId) $($current.HelpText) $($current.ItemStatus)"
                    if ($markers -match '(?i)\b(?:selected|active|current|checked)\b') { $score += 60 }
                    if ($score -gt $selectedScore) {
                        $selected = $element
                        $selectedScore = $score
                    }
                  }
                }
                if ($selected -and $selectedScore -gt 0) {
                    $message = @{ kind = 'desktop'; title = $selected.Current.Name; modelLabel = $modelLabel }
                }
            }
        }
        if ($foreground.ProcessName -ine 'ChatGPT') {
            $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'codex.exe'")
            $byId = @{}
            foreach ($candidate in $processes) {
                if ($candidate.Name -ine 'codex.exe' -or [string]$candidate.CommandLine -match '\bapp-server\b') { continue }
                $node = $candidate
                while ($node) {
                    if ([int]$node.ProcessId -eq [int]$foregroundPid) {
                        $message = @{ kind = 'cli'; pid = [int]$candidate.ProcessId }
                        break
                    }
                    $parentId = [int]$node.ParentProcessId
                    if ($parentId -le 0) { break }
                    if (-not $byId.ContainsKey($parentId)) {
                        $byId[$parentId] = Get-CimInstance Win32_Process -Filter "ProcessId = $parentId" -ErrorAction SilentlyContinue
                    }
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
    Start-Sleep -Milliseconds ${UI_POLL_MS}
}
`;

export function parseCodexUiSelection(line: string): CodexUiSelection | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.kind === "cli" && typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0) {
      return { kind: "cli", pid: value.pid };
    }
    if (
      value.kind === "desktop" &&
      typeof value.title === "string" && value.title.trim() !== ""
    ) {
      const settings = parseCodexModelLabel(
        typeof value.modelLabel === "string" ? value.modelLabel : undefined,
      );
      return { kind: "desktop", title: value.title.trim(), ...settings };
    }
  } catch {}
  return undefined;
}

const EFFORT_LABELS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

export function parseCodexModelLabel(
  label: string | undefined,
): { model?: string; effort?: string } {
  if (!label) return {};
  const tokens = label
    .trim()
    .replace(/^gpt[-\s]*/i, "")
    .replace(/extra[\s-]+high/gi, "xhigh")
    .replace(/\blight\b/gi, "low")
    .replace(/[·•()]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const version = tokens.shift();
  if (!version || !/^\d+(?:\.\d+)*$/.test(version)) return {};
  const effortIndex = tokens.findIndex((token) => EFFORT_LABELS.has(token.toLowerCase()));
  const effort = effortIndex >= 0 ? tokens[effortIndex]!.toLowerCase() : undefined;
  const suffix = tokens
    .slice(0, effortIndex >= 0 ? effortIndex : tokens.length)
    .filter((token) => token.toLowerCase() !== "fast")
    .map((token) => token.toLowerCase())
    .join("-");
  return {
    model: `gpt-${version}${suffix ? `-${suffix}` : ""}`,
    ...(effort ? { effort } : {}),
  };
}

export function selectionForCodexCliSession(
  sessionId: string | undefined,
): CodexDesktopSelection | undefined {
  return sessionId ? { remote: false, sessionId } : undefined;
}

export function localProjectRootsFromState(raw: string): string[] {
  try {
    const state = JSON.parse(raw) as Record<string, unknown>;
    const selected = state["selected-project"] as Record<string, unknown> | undefined;
    if (selected?.type === "local" && typeof selected.projectId === "string") {
      const projects = state["local-projects"] as Record<string, unknown> | undefined;
      const project = projects?.[selected.projectId] as Record<string, unknown> | undefined;
      const selectedRoots = Array.isArray(project?.rootPaths)
        ? project.rootPaths.filter((root): root is string => typeof root === "string" && root.trim() !== "")
        : [];
      if (selectedRoots.length > 0) return selectedRoots;
    }
    if (Object.prototype.hasOwnProperty.call(state, "selected-project") && !selected) return [];
    const activeRoots = state["active-workspace-roots"];
    return Array.isArray(activeRoots)
      ? activeRoots.filter((root): root is string => typeof root === "string" && root.trim() !== "")
      : [];
  } catch { return []; }
}

function normalizedPath(value: string): string {
  const path = value.trim().replace(/^\\\\\?\\/, "").replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(path) || path.startsWith("//") ? path.toLowerCase() : path;
}

function titleTokens(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter((token) => token.length >= 3);
}

function tokenMatches(left: string, right: string): boolean {
  if (left === right) return true;
  const prefixLength = Math.min(5, left.length, right.length);
  return prefixLength >= 4 && left.slice(0, prefixLength) === right.slice(0, prefixLength);
}

export function selectLocalSessionByTitle(
  title: string,
  candidates: LocalSessionTitleCandidate[],
  projectRoots: string[] = [],
): string | undefined {
  const roots = projectRoots.map(normalizedPath).filter(Boolean);
  const scoped = candidates.filter((candidate) => {
    const cwd = normalizedPath(candidate.cwd);
    return roots.length === 0 || roots.some((root) => cwd === root || cwd.startsWith(`${root}/`));
  });
  const exact = scoped.filter((candidate) => candidate.title.trim().toLocaleLowerCase() === title.trim().toLocaleLowerCase());
  if (exact.length > 0) return exact.length === 1 ? exact[0]!.id.toLowerCase() : undefined;
  const selectedTokens = titleTokens(title);
  if (selectedTokens.length === 0) return undefined;
  let best: { id: string; score: number } | undefined;
  let tied = false;
  for (const candidate of scoped) {
    const candidateTokens = titleTokens(candidate.title);
    const matched = selectedTokens.filter((selected) =>
      candidateTokens.some((candidateToken) => tokenMatches(selected, candidateToken))
    ).length;
    if (matched < Math.min(2, selectedTokens.length)) continue;
    const score = matched / selectedTokens.length;
    if (score < 0.6 || (best && score < best.score)) continue;
    if (best && score === best.score) { tied = true; continue; }
    best = { id: candidate.id, score };
    tied = false;
  }
  return tied ? undefined : best?.id.toLowerCase();
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
  private resolvedSessionId?: string;
  private stateRaw?: string;
  private uiSelection?: CodexUiSelection;
  private uiChild?: ChildProcess;
  private stateDatabase?: DatabaseSync;
  private hasNameColumn = false;

  constructor(
    codexHome: string,
    private readonly onUpdate: (selection: CodexDesktopSelection) => void,
    private readonly options: { pollMs?: number; watchUi?: boolean } = {},
  ) {
    this.stateFile = join(codexHome, ".codex-global-state.json");
    this.stateDatabaseFile = join(codexHome, "state_5.sqlite");
    this.logsDatabaseFile = join(codexHome, "logs_2.sqlite");
  }

  start(): void {
    void this.scan();
    this.timer = setInterval(() => void this.scan(), this.options.pollMs ?? POLL_MS);
    if (process.platform === "win32" && this.options.watchUi !== false) void this.watchUi();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.uiChild?.kill();
    this.stateDatabase?.close();
    this.stateDatabase = undefined;
  }

  private async scan(): Promise<void> {
    if (this.stopped || this.reading) return;
    this.reading = true;
    try {
      const info = await stat(this.stateFile);
      if (info.mtimeMs !== this.lastMtime || !this.stateRaw) {
        this.stateRaw = await readFile(this.stateFile, "utf8");
        this.lastMtime = info.mtimeMs;
      } else if (!this.uiSelection || this.resolvedSessionId) return;
      if (this.stopped) return;
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
    const key = JSON.stringify(selection);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.resolvedSessionId = selection.sessionId;
    log.debug(`selected ${selection.remote ? "remote" : "local"}${selection.remotePath ? ` path=${selection.remotePath}` : ""}${selection.sessionId ? ` session=${selection.sessionId}` : ""}`);
    this.onUpdate(selection);
  }

  setUiSelection(selection: CodexUiSelection): void {
    this.uiSelection = selection;
    if (!this.stateRaw || this.stopped) return;
    const resolved = this.resolveSelection(this.stateRaw);
    if (resolved) this.report(resolved);
  }

  private resolveSelection(raw: string): CodexDesktopSelection | undefined {
    const ui = this.uiSelection;
    if (!ui) return parseCodexDesktopSelection(raw);
    if (ui.kind === "cli") {
      const sessionId = this.sessionIdForProcess(ui.pid);
      return selectionForCodexCliSession(sessionId);
    }
    const base = parseCodexDesktopSelection(raw);
    if (base?.remote) {
      return { ...base, threadTitle: ui.title, model: ui.model, effort: ui.effort };
    }
    const sessionId = this.localSessionId(ui.title, this.localProjectRoots(raw));
    return sessionId
      ? { remote: false, sessionId, threadTitle: ui.title, model: ui.model, effort: ui.effort }
      : { remote: false, threadTitle: ui.title, model: ui.model, effort: ui.effort };
  }

  private localProjectRoots(raw: string): string[] {
    return localProjectRootsFromState(raw);
  }

  private localSessionId(title: string, projectRoots: string[]): string | undefined {
    try {
      if (!this.stateDatabase) {
        this.stateDatabase = new DatabaseSync(this.stateDatabaseFile, { readOnly: true });
        this.hasNameColumn = this.stateDatabase.prepare("PRAGMA table_info(threads)").all()
          .some((column) => column.name === "name");
      }
      const label = this.hasNameColumn ? "COALESCE(NULLIF(name, ''), title)" : "title";
      const exact = this.stateDatabase.prepare(
        `SELECT id, ${label} AS title, cwd FROM threads WHERE archived = 0 AND ${label} = ? COLLATE NOCASE`,
      ).all(title) as unknown as LocalSessionTitleCandidate[];
      if (exact.length > 0) {
        return selectLocalSessionByTitle(title, exact, projectRoots);
      }
      const candidates = this.stateDatabase.prepare(
        `SELECT id, ${label} AS title, cwd FROM threads WHERE archived = 0 AND ${label} <> '' ORDER BY recency_at_ms DESC, updated_at_ms DESC LIMIT 500`,
      ).all() as unknown as LocalSessionTitleCandidate[];
      return selectLocalSessionByTitle(title, candidates, projectRoots);
    } catch {
      this.stateDatabase?.close();
      this.stateDatabase = undefined;
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
        try {
          await Promise.all([
            exited,
            (async () => {
              for await (const line of lines) {
                if (this.stopped) break;
                const selection = parseCodexUiSelection(line);
                if (selection) this.setUiSelection(selection);
              }
            })(),
          ]);
        } finally {
          lines.close();
        }
      } catch (err) {
        if (!this.stopped) log.debug(`UI selection failed: ${(err as Error).message}`);
      } finally {
        this.uiChild?.kill();
        this.uiChild = undefined;
      }
      if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}
