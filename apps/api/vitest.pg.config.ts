import { defineConfig } from "vitest/config";

import { remoteTestTimeouts } from "../../packages/db/test/pg-timing";

// The api's real-Postgres integration tests (`*.pg.test.ts`). They exercise the
// remote-replay orchestration end to end against a REAL Postgres under the non-owner
// webhook_app role + RLS, via the @webhook-co/db test harness (test/pg.ts spins up an
// ephemeral cluster locally; CI uses the TEST_DATABASE_URL service container). Run by
// `pnpm test:db` alongside @webhook-co/db, NOT by the binary-less `pnpm test` lane.
//
// Against the nightly Neon branch the budgets widen and the shared @webhook-co/db
// globalSetup pre-warms the compute (both no-ops for the local/CI-service path) — Neon's
// latency variance would otherwise trip the tight local timeouts.
//
// No coverage here: this config runs only the pg suite, so a whole-package coverage
// denominator would be meaningless. The fast unit suite (vitest.config.ts) owns coverage.
const { testTimeout, hookTimeout } = remoteTestTimeouts();

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.pg.test.ts"],
    globalSetup: ["../../packages/db/test/global-setup.ts"],
    // Each file provisions a fresh database; run serially with generous timeouts so
    // concurrent suites don't fight over roles, and cluster start-up has room.
    fileParallelism: false,
    hookTimeout,
    testTimeout,
  },
});
