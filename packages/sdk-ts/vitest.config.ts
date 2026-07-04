import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Generated types carry no runtime code; the barrel is pure re-exports; test files test themselves.
      exclude: ["src/**/*.test.ts", "src/index.ts", "src/generated/**"],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 88 },
    },
  },
});
