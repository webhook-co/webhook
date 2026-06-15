import { defineConfig } from "vitest/config";

// The CLI runs in Node/Bun, so its tests use the `node` environment (not the Workers
// pool). Everything routes through the injected AppContext, so commands and the
// credential store are exercised with fake I/O — no real filesystem mutation outside a
// tmpdir, no real process spawning. bin.ts (the thin `#!/usr/bin/env node` shell) and
// index.ts (the re-export barrel) are wiring, not logic, and are coverage-excluded.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/bin.ts", "src/index.ts", "src/io.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 80,
      },
    },
  },
});
