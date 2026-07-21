import { expect, test } from "vitest";
import { join, resolve } from "node:path";
import {
  DEFAULT_DISCORD_APPLICATION_ID,
  DEFAULT_RICH_PRESENCE_ASSET_KEY,
  loadConfig,
  resolveCodexHome,
  resolvePresenceDataDir,
  resolveRemoteHosts,
  type RuntimePaths,
} from "../src/config.ts";

const runtime: RuntimePaths = {
  userHome: join("C:", "Users", "example"),
  cwd: join("C:", "apps", "codex-presence"),
  platform: "win32",
};

test("Codex home is derived from the current user's home", () => {
  expect(resolveCodexHome({}, runtime)).toBe(join(runtime.userHome, ".codex"));
});

test("configured paths support home expansion and relative paths", () => {
  expect(resolveCodexHome({ CODEX_HOME: "~/.custom-codex" }, runtime)).toBe(
    resolve(runtime.userHome, ".custom-codex"),
  );
  expect(resolvePresenceDataDir({ CODEX_PRESENCE_DATA_DIR: "state" }, runtime)).toBe(
    resolve(runtime.cwd, "state"),
  );
});

test("presence data uses the operating system data location", () => {
  const localAppData = join(runtime.userHome, "AppData", "Local");
  expect(resolvePresenceDataDir({ LOCALAPPDATA: localAppData }, runtime)).toBe(
    join(localAppData, "Codex Discord Presence"),
  );

  const linux = { ...runtime, platform: "linux" as const };
  expect(resolvePresenceDataDir({ XDG_STATE_HOME: "state" }, linux)).toBe(
    join(resolve(runtime.cwd, "state"), "codex-discord-presence"),
  );
});

test("loadConfig keeps every generated data file under the resolved data directory", () => {
  const config = loadConfig(
    {
      CODEX_DISCORD_APPLICATION_ID: "app-id",
      LOCALAPPDATA: join(runtime.userHome, "AppData", "Local"),
    },
    runtime,
  );
  expect(config.codexHome).toBe(join(runtime.userHome, ".codex"));
  expect(config.largeImageKey).toBe(DEFAULT_RICH_PRESENCE_ASSET_KEY);
  expect(config.largeImageUrl).toBeUndefined();
  expect(config.logFile).toBe(join(config.dataDir, "codex-discord-presence.log"));
  expect(config.serviceTierCacheFile).toBe(join(config.dataDir, "service-tiers.json"));
});

test("shared art is the default and can be overridden or disabled", () => {
  expect(loadConfig({}, runtime).largeImageKey).toBe(DEFAULT_RICH_PRESENCE_ASSET_KEY);
  expect(loadConfig({ CODEX_LARGE_IMAGE_KEY: "custom-codex-art" }, runtime).largeImageKey).toBe(
    "custom-codex-art",
  );
  expect(loadConfig({ CODEX_LARGE_IMAGE_KEY: "off" }, runtime).largeImageKey).toBeUndefined();
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
