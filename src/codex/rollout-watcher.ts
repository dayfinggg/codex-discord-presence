import { watch, type FSWatcher } from "node:fs";
import { open, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../util/logger.ts";
import { parseRollout, sessionIdFromPath, type CodexEvent } from "./rollout-parser.ts";

const log = createLogger("codex-watch");
const POLL_MS = 1_000;
const DISCOVERY_POLL_MS = 5_000;
const PRIME_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const TRACK_IDLE_MS = 15 * 60 * 1000;
const TAIL_BYTES = 256 * 1024;
const HEAD_CHUNK_BYTES = 1024 * 1024;
const CONTEXT_MARKERS = ['"session_meta"', '"turn_context"', '"thread_settings_applied"'];

interface Tracked {
  offset: number;
  leftover: Buffer;
  lastSeen: number;
}

export type CodexEventSink = (sessionId: string, remote: boolean, event: CodexEvent, at?: number) => void;

export class RolloutWatcher {
  private readonly sessionsDir: string;
  private readonly tracked = new Map<string, Tracked>();
  private readonly reading = new Set<string>();
  private watcher?: FSWatcher;
  private pollTimer?: ReturnType<typeof setInterval>;
  private lastDiscoveryAt = 0;
  private stopped = false;

  constructor(codexHome: string, private readonly onEvent: CodexEventSink) {
    this.sessionsDir = join(codexHome, "sessions");
  }

  async start(): Promise<void> {
    await this.prime();
    try {
      this.watcher = watch(this.sessionsDir, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const name = filename.toString();
        if (!name.endsWith(".jsonl") || name.includes("archived_sessions")) return;
        void this.readFile(join(this.sessionsDir, name), false);
      });
      this.watcher.on("error", (err) => {
        log.warn(`watch error: ${err.message}; relying on poll`);
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch (err) {
      log.warn(`fs.watch unavailable: ${(err as Error).message}; relying on poll`);
    }
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
    log.info(`watching ${this.sessionsDir}`);
  }

  stop(): void {
    this.stopped = true;
    if (this.watcher) this.watcher.close();
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  private async listRecent(): Promise<string[]> {
    const out: string[] = [];
    const cutoff = Date.now() - PRIME_MAX_AGE_MS;
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === "archived_sessions") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.name.endsWith(".jsonl")) {
          try {
            const info = await stat(full);
            if (info.mtimeMs >= cutoff) out.push(full);
          } catch {
            /* ignore */
          }
        }
      }
    };
    await walk(this.sessionsDir);
    return out;
  }

  private async prime(): Promise<void> {
    const files = await this.listRecent();
    for (const file of files) {
      await this.primeFile(file);
    }
  }

  private async primeFile(file: string): Promise<void> {
    const sessionId = sessionIdFromPath(file);
    if (!sessionId) return;
    let info;
    try {
      info = await stat(file);
    } catch {
      return;
    }
    const size = info.size;
    this.tracked.set(file, { offset: size, leftover: Buffer.alloc(0), lastSeen: Date.now() });

    let handle;
    try {
      handle = await open(file, "r");
    } catch {
      return;
    }
    try {
      const start = Math.max(0, size - TAIL_BYTES);
      if (start > 0) await this.scanHeadContext(handle, start, sessionId);
      const length = size - start;
      if (length > 0) {
        const buf = Buffer.alloc(length);
        await handle.read(buf, 0, length, start);
        let text = buf.toString("utf8");
        if (start > 0) {
          const nl = text.indexOf("\n");
          text = nl >= 0 ? text.slice(nl + 1) : "";
        }
        for (const line of text.split("\n")) {
          if (line.trim() !== "") this.dispatch(sessionId, line);
        }
      }
    } finally {
      await handle.close();
    }
  }

  private async scanHeadContext(
    handle: Awaited<ReturnType<typeof open>>,
    end: number,
    sessionId: string,
  ): Promise<void> {
    const buf = Buffer.alloc(Math.min(HEAD_CHUNK_BYTES, end));
    let offset = 0;
    let leftover = Buffer.alloc(0);
    while (offset < end) {
      const length = Math.min(buf.length, end - offset);
      const { bytesRead } = await handle.read(buf, 0, length, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
      const combined = Buffer.concat([leftover, buf.subarray(0, bytesRead)]);
      const lastNl = combined.lastIndexOf(0x0a);
      if (lastNl < 0) {
        leftover = combined;
        continue;
      }
      const complete = combined.subarray(0, lastNl).toString("utf8");
      leftover = Buffer.from(combined.subarray(lastNl + 1));
      for (const line of complete.split("\n")) {
        if (line.trim() === "") continue;
        if (CONTEXT_MARKERS.some((marker) => line.includes(marker))) this.dispatch(sessionId, line);
      }
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    if (!this.watcher && now - this.lastDiscoveryAt >= DISCOVERY_POLL_MS) {
      this.lastDiscoveryAt = now;
      for (const file of await this.listRecent()) {
        if (!this.tracked.has(file)) await this.primeFile(file);
      }
    }
    for (const [file, entry] of this.tracked) {
      if (this.watcher && now - entry.lastSeen > TRACK_IDLE_MS) {
        this.tracked.delete(file);
        continue;
      }
      await this.readFile(file, true);
    }
  }

  private async readFile(file: string, tracking: boolean): Promise<void> {
    if (this.stopped || this.reading.has(file)) return;
    const sessionId = sessionIdFromPath(file);
    if (!sessionId) return;
    this.reading.add(file);
    try {
      await this.readFileLocked(file, tracking, sessionId);
    } finally {
      this.reading.delete(file);
    }
  }

  private async readFileLocked(file: string, tracking: boolean, sessionId: string): Promise<void> {
    let info;
    try {
      info = await stat(file);
    } catch {
      return;
    }

    let entry = this.tracked.get(file);
    if (!entry) {
      if (tracking) return;
      entry = { offset: 0, leftover: Buffer.alloc(0), lastSeen: Date.now() };
      this.tracked.set(file, entry);
    }

    if (info.size < entry.offset) {
      entry.offset = 0;
      entry.leftover = Buffer.alloc(0);
    }
    if (info.size === entry.offset) return;

    const length = info.size - entry.offset;
    let handle;
    try {
      handle = await open(file, "r");
    } catch {
      return;
    }
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, entry.offset);
      entry.offset += bytesRead;
      entry.lastSeen = Date.now();
      const combined = Buffer.concat([entry.leftover, buf.subarray(0, bytesRead)]);
      const lastNl = combined.lastIndexOf(0x0a);
      if (lastNl < 0) {
        entry.leftover = combined;
        return;
      }
      const complete = combined.subarray(0, lastNl).toString("utf8");
      entry.leftover = combined.subarray(lastNl + 1);
      for (const line of complete.split("\n")) {
        if (line.trim() !== "") this.dispatch(sessionId, line);
      }
    } finally {
      await handle.close();
    }
  }

  private dispatch(sessionId: string, line: string): void {
    const parsed = parseRollout(line);
    if (parsed) this.onEvent(sessionId, false, parsed.event, parsed.at);
  }
}
