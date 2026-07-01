import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The generator + golden-file harness are exercised by the drift-guard tests; the golden JSON
      // and the barrel are data/re-exports with no branches to cover.
      exclude: ["src/**/*.test.ts", "src/index.ts", "src/openapi.json"],
    },
  },
});
