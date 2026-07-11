import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { remoteTestTimeouts } from "../../packages/db/test/pg-timing";

// The web dashboard's real-Postgres integration tests (`*.pg.test.ts`). The unit config
// (vitest.config.ts) is jsdom + component tests; this one runs the SERVER mutations that
// span the tenant DB end to end against a REAL Postgres under the non-owner webhook_app role
// + RLS, via the @webhook-co/db test harness (test/pg.ts spins an ephemeral cluster locally;
// CI uses the TEST_DATABASE_URL service container). Run by `pnpm test:db`, NOT `pnpm test`.
//
// The `server-only` alias mirrors the unit config: the replay mutations import the
// server-only marker (it throws outside a server build), so stub it to make them importable.
const { testTimeout, hookTimeout } = remoteTestTimeouts();

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./test/server-only-stub.ts", import.meta.url)),
    },
  },
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
