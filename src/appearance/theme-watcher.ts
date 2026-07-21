import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ResolvedTheme } from "./theme-assets.ts";

const execFileAsync = promisify(execFile);

export type ThemePreference = ResolvedTheme | "system";

export function parseCodexThemePreference(text: string): ThemePreference | undefined {
  const match = /^\s*appearanceTheme\s*=\s*["']?(light|dark|system)["']?\s*(?:#.*)?$/im.exec(text);
  return match?.[1]?.toLowerCase() as ThemePreference | undefined;
}

export function resolveTheme(
  preference: ThemePreference | undefined,
  systemTheme: ResolvedTheme,
): ResolvedTheme {
  return preference === "light" || preference === "dark" ? preference : systemTheme;
}

function readCodexPreference(codexHome: string): ThemePreference | undefined {
  try {
    return parseCodexThemePreference(readFileSync(join(codexHome, "config.toml"), "utf8"));
  } catch {
    return undefined;
  }
}

async function readSystemTheme(): Promise<ResolvedTheme> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "reg.exe",
        [
          "query",
          "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
          "/v",
          "AppsUseLightTheme",
        ],
        { windowsHide: true },
      );
      const match = /AppsUseLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout);
      if (match?.[1]) return Number.parseInt(match[1], 16) === 0 ? "dark" : "light";
    } else if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("defaults", ["read", "-g", "AppleInterfaceStyle"]);
      return /dark/i.test(stdout) ? "dark" : "light";
    } else {
      const { stdout } = await execFileAsync("gsettings", [
        "get",
        "org.gnome.desktop.interface",
        "color-scheme",
      ]);
      return /dark/i.test(stdout) ? "dark" : "light";
    }
  } catch {
    return "light";
  }
  return "light";
}

export class CodexThemeWatcher {
  private readonly codexHome: string;
  private readonly pollIntervalMs: number;
  private readonly onChange: (theme: ResolvedTheme) => void;
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private current?: ResolvedTheme;

  constructor(
    codexHome: string,
    onChange: (theme: ResolvedTheme) => void,
    pollIntervalMs = 2_000,
  ) {
    this.codexHome = codexHome;
    this.onChange = onChange;
    this.pollIntervalMs = pollIntervalMs;
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const theme = resolveTheme(readCodexPreference(this.codexHome), await readSystemTheme());
      if (theme !== this.current) {
        this.current = theme;
        this.onChange(theme);
      }
    } finally {
      this.polling = false;
    }
  }
}
