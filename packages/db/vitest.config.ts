import { defineConfig } from "vitest/config";

// The db package's tests exercise real Postgres (RLS policies, roles, the
// ingest_event function, the audit trigger). They run in the Node environment
// against an ephemeral local Postgres started by the test harness (test/pg.ts),
// NOT the Workers pool — RLS + role behavior must be validated on a real engine.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // RLS/migration tests provision a fresh database; give them room and run
    // serially so concurrent suites don't fight over roles/search_path.
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "test/**/*.ts"],
    },
  },
});
