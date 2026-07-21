import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface Config {
  applicationId: string;
  appName: string;
  largeImageKey?: string;
  largeImageKeyLight?: string;
  largeImageKeyDark?: string;
  largeImageUrl?: string;
  smallImageKey?: string;
  smallImageKeyLight?: string;
  smallImageKeyDark?: string;
  smallImageUrl?: string;
  codexHome: string;
  dataDir: string;
  logFile: string;
  serviceTierCacheFile: string;
  remoteHosts: string[];
  remoteDiscovery: boolean;
  planNameOverride?: string;
}

export const DEFAULT_DISCORD_APPLICATION_ID = "1521142415547826177";
export const DEFAULT_RICH_PRESENCE_ASSET_KEY = "codex-color";
const SSH_ALIAS = /^[a-z0-9](?:[a-z0-9._-]{0,252}[a-z0-9])?$/i;

export interface RuntimePaths {
  userHome: string;
  cwd: string;
  platform: NodeJS.Platform;
}

function currentRuntimePaths(): RuntimePaths {
  return {
    userHome: homedir(),
    cwd: process.cwd(),
    platform: process.platform,
  };
}

function optionalAsset(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || ["off", "none", "default"].includes(trimmed.toLowerCase())) return undefined;
  return trimmed;
}

function pathApi(runtime: RuntimePaths): typeof posix {
  return runtime.platform === "win32" ? win32 : posix;
}

export function resolveUserPath(value: string, runtime: RuntimePaths): string {
  const paths = pathApi(runtime);
  const trimmed = value.trim();
  if (trimmed === "~") return paths.normalize(runtime.userHome);
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return paths.resolve(runtime.userHome, trimmed.slice(2));
  }
  return paths.isAbsolute(trimmed) ? paths.normalize(trimmed) : paths.resolve(runtime.cwd, trimmed);
}

export function resolveCodexHome(
  env: Record<string, string | undefined>,
  runtime: RuntimePaths,
): string {
  const paths = pathApi(runtime);
  const configured = env.CODEX_HOME?.trim();
  return configured ? resolveUserPath(configured, runtime) : paths.join(runtime.userHome, ".codex");
}

export function resolvePresenceDataDir(
  env: Record<string, string | undefined>,
  runtime: RuntimePaths,
): string {
  const paths = pathApi(runtime);
  const configured = env.CODEX_PRESENCE_DATA_DIR?.trim();
  if (configured) return resolveUserPath(configured, runtime);

  if (runtime.platform === "win32") {
    const base = env.LOCALAPPDATA?.trim() || env.APPDATA?.trim();
    return base
      ? paths.join(resolveUserPath(base, runtime), "Codex Discord Presence")
      : paths.join(runtime.userHome, "AppData", "Local", "Codex Discord Presence");
  }
  if (runtime.platform === "darwin") {
    return paths.join(runtime.userHome, "Library", "Application Support", "Codex Discord Presence");
  }
  const stateHome = env.XDG_STATE_HOME?.trim();
  return stateHome
    ? paths.join(resolveUserPath(stateHome, runtime), "codex-discord-presence")
    : paths.join(runtime.userHome, ".local", "state", "codex-discord-presence");
}

export function resolveRemoteHosts(value: string | undefined): {
  hosts: string[];
  discovery: boolean;
} {
  const configured = value?.trim();
  if (!configured) return { hosts: [], discovery: true };
  if (configured.toLowerCase() === "off") return { hosts: [], discovery: false };

  const hosts = [...new Set(configured.split(",").map((host) => host.trim()).filter(Boolean))];
  const invalid = hosts.find((host) => !SSH_ALIAS.test(host));
  if (invalid) {
    throw new Error(`CODEX_REMOTE_HOSTS contains an unsafe SSH alias: ${JSON.stringify(invalid)}`);
  }
  return { hosts, discovery: false };
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  runtime: RuntimePaths = currentRuntimePaths(),
): Config {
  const paths = pathApi(runtime);
  const applicationId = env.CODEX_DISCORD_APPLICATION_ID?.trim() || DEFAULT_DISCORD_APPLICATION_ID;

  const codexHome = resolveCodexHome(env, runtime);
  const dataDir = resolvePresenceDataDir(env, runtime);
  const appName = env.CODEX_APP_NAME?.trim();
  const largeImageKey = optionalAsset(
    env.CODEX_LARGE_IMAGE_KEY ?? DEFAULT_RICH_PRESENCE_ASSET_KEY,
  );
  const largeImageUrl = optionalAsset(env.CODEX_LARGE_IMAGE_URL);
  const largeImageKeyLight = optionalAsset(env.CODEX_LARGE_IMAGE_KEY_LIGHT);
  const largeImageKeyDark = optionalAsset(env.CODEX_LARGE_IMAGE_KEY_DARK);
  const smallImageKey = optionalAsset(env.CODEX_SMALL_IMAGE_KEY);
  const smallImageKeyLight = optionalAsset(env.CODEX_SMALL_IMAGE_KEY_LIGHT);
  const smallImageKeyDark = optionalAsset(env.CODEX_SMALL_IMAGE_KEY_DARK);
  const smallImageUrl = optionalAsset(env.CODEX_SMALL_IMAGE_URL);
  const planNameOverride = env.CODEX_PLAN_NAME?.trim();
  const configuredLogFile = env.RPC_LOG_FILE?.trim();
  const remote = resolveRemoteHosts(env.CODEX_REMOTE_HOSTS);

  return {
    applicationId,
    appName: appName || "Codex",
    largeImageKey,
    largeImageKeyLight,
    largeImageKeyDark,
    largeImageUrl,
    smallImageKey,
    smallImageKeyLight,
    smallImageKeyDark,
    smallImageUrl,
    codexHome,
    dataDir,
    logFile: configuredLogFile
      ? resolveUserPath(configuredLogFile, runtime)
      : paths.join(dataDir, "codex-discord-presence.log"),
    serviceTierCacheFile: paths.join(dataDir, "service-tiers.json"),
    remoteHosts: remote.hosts,
    remoteDiscovery: remote.discovery,
    planNameOverride: planNameOverride || undefined,
  };
}
