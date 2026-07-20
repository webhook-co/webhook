import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The generated golden + its type barrel carry no branching logic to cover.
      exclude: ["src/**/*.test.ts", "src/recipes.generated.ts", "src/index.ts", "src/types.ts"],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 85,
      },
    },
  },
});
