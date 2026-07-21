import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../util/logger.ts";

const log = createLogger("codex-selection");
const POLL_MS = 1_000;

export interface CodexDesktopSelection {
  remote: boolean;
  remotePath?: string;
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
  private timer?: ReturnType<typeof setInterval>;
  private reading = false;
  private stopped = false;
  private lastMtime?: number;
  private lastKey?: string;

  constructor(codexHome: string, private readonly onUpdate: (selection: CodexDesktopSelection) => void) {
    this.stateFile = join(codexHome, ".codex-global-state.json");
  }

  start(): void {
    void this.scan();
    this.timer = setInterval(() => void this.scan(), POLL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async scan(): Promise<void> {
    if (this.stopped || this.reading) return;
    this.reading = true;
    try {
      const info = await stat(this.stateFile);
      if (info.mtimeMs === this.lastMtime) return;
      const selection = parseCodexDesktopSelection(await readFile(this.stateFile, "utf8"));
      if (!selection) return;
      this.lastMtime = info.mtimeMs;
      const key = `${selection.remote}:${selection.remotePath ?? ""}`;
      if (key === this.lastKey) return;
      this.lastKey = key;
      log.debug(`selected ${selection.remote ? "remote" : "local"}${selection.remotePath ? ` path=${selection.remotePath}` : ""}`);
      this.onUpdate(selection);
    } catch (err) {
      log.debug(`selection read failed: ${(err as Error).message}`);
    } finally {
      this.reading = false;
    }
  }
}
