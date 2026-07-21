import { expect, test } from "vitest";
import {
  parseCodexThemePreference,
  resolveTheme,
} from "../src/appearance/theme-watcher.ts";

test("Codex appearanceTheme is parsed from config.toml", () => {
  expect(parseCodexThemePreference('appearanceTheme = "system"\n')).toBe("system");
  expect(parseCodexThemePreference("appearanceTheme='dark' # selected in app\n")).toBe("dark");
});

test("system theme is only used for automatic appearance", () => {
  expect(resolveTheme("light", "dark")).toBe("light");
  expect(resolveTheme("dark", "light")).toBe("dark");
  expect(resolveTheme("system", "dark")).toBe("dark");
});
