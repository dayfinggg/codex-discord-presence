import { expect, test } from "vitest";
import { activityAssetsForTheme } from "../src/appearance/theme-assets.ts";

test("the selected appearance theme controls both Discord image keys", () => {
  const assets = {
    appName: "Codex",
    largeImageKey: "large-fallback",
    largeImageKeyLight: "large-light",
    largeImageKeyDark: "large-dark",
    smallImageKey: "small-fallback",
    smallImageKeyLight: "small-light",
    smallImageKeyDark: "small-dark",
  };

  expect(activityAssetsForTheme(assets, "light")).toMatchObject({
    largeImageKey: "large-light",
    smallImageKey: "small-light",
  });
  expect(activityAssetsForTheme(assets, "dark")).toMatchObject({
    largeImageKey: "large-dark",
    smallImageKey: "small-dark",
  });
});

test("legacy image keys remain fallbacks while themed assets are not configured", () => {
  expect(
    activityAssetsForTheme(
      { appName: "Codex", largeImageKey: "large", smallImageKey: "small" },
      "dark",
    ),
  ).toMatchObject({ largeImageKey: "large", smallImageKey: "small" });
});
