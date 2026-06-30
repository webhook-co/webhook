import { configDefaults, defineConfig } from "vitest/config";

// The API auth-surface tests are pure (token extraction + scope enforcement + the
// 401/403 challenge), with verifyBearer injected as a fake — so they run in plain Node,
// not the Workers pool. The runtime Worker (when it lands) gets its own workerd suite.
//
// `*.pg.test.ts` files are real-Postgres integration tests (they spin up an ephemeral
// cluster via the db harness). Those are EXCLUDED here and run separately under
// `pnpm test:db` (vitest.pg.config.ts) in the Postgres-equipped CI lane — exactly like
// @webhook-co/db. Running them in the binary-less `test` lane fails with `initdb ENOENT`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "src/**/*.pg.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
