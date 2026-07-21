import { defineConfig } from "vitest/config";

const disabledWarning = "--disable-warning=ExperimentalWarning";
if (!process.env.NODE_OPTIONS?.includes(disabledWarning)) {
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, disabledWarning].filter(Boolean).join(" ");
}

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
