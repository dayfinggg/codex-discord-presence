import { expect, test } from "vitest";
import { posix, win32 } from "node:path";
import {
  DEFAULT_DISCORD_APPLICATION_ID,
  DEFAULT_LARGE_IMAGE_KEY_DARK,
  DEFAULT_LARGE_IMAGE_KEY_LIGHT,
  DEFAULT_RICH_PRESENCE_ASSET_KEY,
  DEFAULT_SMALL_IMAGE_KEY,
  DEFAULT_SMALL_IMAGE_KEY_DARK,
  DEFAULT_SMALL_IMAGE_KEY_LIGHT,
  loadConfig,
  resolveCodexHome,
  resolvePresenceDataDir,
  resolveRemoteHosts,
  type RuntimePaths,
} from "../src/config.ts";

const runtime: RuntimePaths = {
  userHome: win32.join("C:\\", "Users", "example"),
  cwd: win32.join("C:\\", "apps", "codex-presence"),
  platform: "win32",
};

test("Codex home is derived from the current user's home", () => {
  expect(resolveCodexHome({}, runtime)).toBe(win32.join(runtime.userHome, ".codex"));
});

test("configured paths support home expansion and relative paths", () => {
  expect(resolveCodexHome({ CODEX_HOME: "~/.custom-codex" }, runtime)).toBe(
    win32.resolve(runtime.userHome, ".custom-codex"),
  );
  expect(resolvePresenceDataDir({ CODEX_PRESENCE_DATA_DIR: "state" }, runtime)).toBe(
    win32.resolve(runtime.cwd, "state"),
  );
});

test("presence data uses the operating system data location", () => {
  const localAppData = win32.join(runtime.userHome, "AppData", "Local");
  expect(resolvePresenceDataDir({ LOCALAPPDATA: localAppData }, runtime)).toBe(
    win32.join(localAppData, "Codex Discord Presence"),
  );

  const linux: RuntimePaths = {
    userHome: "/home/example",
    cwd: "/opt/codex-presence",
    platform: "linux",
  };
  expect(resolvePresenceDataDir({ XDG_STATE_HOME: "state" }, linux)).toBe(
    posix.join(posix.resolve(linux.cwd, "state"), "codex-discord-presence"),
  );
});

test("loadConfig keeps every generated data file under the resolved data directory", () => {
  const config = loadConfig(
    {
      CODEX_DISCORD_APPLICATION_ID: "app-id",
      LOCALAPPDATA: win32.join(runtime.userHome, "AppData", "Local"),
    },
    runtime,
  );
  expect(config.codexHome).toBe(win32.join(runtime.userHome, ".codex"));
  expect(config.largeImageKey).toBe(DEFAULT_RICH_PRESENCE_ASSET_KEY);
  expect(config.largeImageUrl).toBeUndefined();
  expect(config.logFile).toBe(win32.join(config.dataDir, "codex-discord-presence.log"));
  expect(config.serviceTierCacheFile).toBe(win32.join(config.dataDir, "service-tiers.json"));
});

test("zero-config mode includes themed art and the statistics icon", () => {
  const config = loadConfig({}, runtime);
  expect(config.largeImageKey).toBe(DEFAULT_RICH_PRESENCE_ASSET_KEY);
  expect(config.largeImageKeyLight).toBe(DEFAULT_LARGE_IMAGE_KEY_LIGHT);
  expect(config.largeImageKeyDark).toBe(DEFAULT_LARGE_IMAGE_KEY_DARK);
  expect(config.smallImageKey).toBe(DEFAULT_SMALL_IMAGE_KEY);
  expect(config.smallImageKeyLight).toBe(DEFAULT_SMALL_IMAGE_KEY_LIGHT);
  expect(config.smallImageKeyDark).toBe(DEFAULT_SMALL_IMAGE_KEY_DARK);
});

test("fallback art can be overridden or disabled without hidden themed defaults", () => {
  const custom = loadConfig({ CODEX_LARGE_IMAGE_KEY: "custom-codex-art" }, runtime);
  expect(custom.largeImageKey).toBe("custom-codex-art");
  expect(custom.largeImageKeyLight).toBeUndefined();
  expect(custom.largeImageKeyDark).toBeUndefined();

  const disabled = loadConfig(
    { CODEX_LARGE_IMAGE_KEY: "off", CODEX_SMALL_IMAGE_KEY: "off" },
    runtime,
  );
  expect(disabled.largeImageKey).toBeUndefined();
  expect(disabled.largeImageKeyLight).toBeUndefined();
  expect(disabled.largeImageKeyDark).toBeUndefined();
  expect(disabled.smallImageKey).toBeUndefined();
  expect(disabled.smallImageKeyLight).toBeUndefined();
  expect(disabled.smallImageKeyDark).toBeUndefined();
});

test("the shared Discord application id is the portable default", () => {
  expect(loadConfig({}, runtime).applicationId).toBe(DEFAULT_DISCORD_APPLICATION_ID);
  expect(loadConfig({ CODEX_DISCORD_APPLICATION_ID: "override" }, runtime).applicationId).toBe("override");
});

test("theme-specific Discord assets are loaded without replacing fallback keys", () => {
  const config = loadConfig(
    {
      CODEX_LARGE_IMAGE_KEY: "large-fallback",
      CODEX_LARGE_IMAGE_KEY_LIGHT: "large-light",
      CODEX_LARGE_IMAGE_KEY_DARK: "large-dark",
      CODEX_SMALL_IMAGE_KEY: "small-fallback",
      CODEX_SMALL_IMAGE_KEY_LIGHT: "small-light",
      CODEX_SMALL_IMAGE_KEY_DARK: "small-dark",
    },
    runtime,
  );

  expect(config.largeImageKey).toBe("large-fallback");
  expect(config.largeImageKeyLight).toBe("large-light");
  expect(config.largeImageKeyDark).toBe("large-dark");
  expect(config.smallImageKey).toBe("small-fallback");
  expect(config.smallImageKeyLight).toBe("small-light");
  expect(config.smallImageKeyDark).toBe("small-dark");
});

test("remote hosts are auto-discovered unless explicitly configured or disabled", () => {
  expect(resolveRemoteHosts(undefined)).toEqual({ hosts: [], discovery: true });
  expect(resolveRemoteHosts("off")).toEqual({ hosts: [], discovery: false });
  expect(resolveRemoteHosts("work-box, dev_2,work-box")).toEqual({
    hosts: ["work-box", "dev_2"],
    discovery: false,
  });
});

test("remote hosts reject values that could become ssh options or destinations", () => {
  expect(() => resolveRemoteHosts("-oProxyCommand=bad")).toThrow(/unsafe SSH alias/);
  expect(() => resolveRemoteHosts("user@example.com")).toThrow(/unsafe SSH alias/);
  expect(() => resolveRemoteHosts("host name")).toThrow(/unsafe SSH alias/);
});
