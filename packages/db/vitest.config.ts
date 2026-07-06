import { defineConfig } from "vitest/config";

import { remoteTestTimeouts } from "./test/pg-timing";

// The db package's tests exercise real Postgres (RLS policies, roles, the
// ingest_event function, the audit trigger). They run in the Node environment
// against an ephemeral local Postgres started by the test harness (test/pg.ts),
// NOT the Workers pool — RLS + role behavior must be validated on a real engine.
//
// Against the nightly Neon branch (TEST_DATABASE_URL with TLS) the budgets widen and a
// globalSetup pre-warms the compute — Neon's latency variance would otherwise trip the
// tight local timeouts. Both are no-ops for the local/CI-service path.
const { testTimeout, hookTimeout } = remoteTestTimeouts();

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    // RLS/migration tests provision a fresh database; give them room and run
    // serially so concurrent suites don't fight over roles/search_path.
    fileParallelism: false,
    hookTimeout,
    testTimeout,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "test/**/*.ts"],
    },
  },
});
