// Both come from the package ROOT — this version publishes no "./config" subpath (exports are
// ".", "./types", "./codemods" only), which is also why apps/engine imports cloudflareTest from here.
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// The D1 orchestration suite, run inside the real Workers runtime (workerd) via Miniflare so the email
// handler is exercised against an actual D1 — not a mock. A mocked D1 would happily "prove" a dedup that
// ON CONFLICT never performed.
//
// Separate from vitest.config.ts (node pool) on purpose: the pure suites build their gzip/zip fixtures
// with node:zlib, which is not what workerd runs. Keeping them in node means those tests exercise the same
// standard DecompressionStream the Worker uses, without dragging a node shim into the runtime under test.
//
// The migrations are read from the SAME directory the deploy applies, and handed to the pool as
// TEST_MIGRATIONS. That matters: the suite asserts against the real schema (CHECK constraints, the UNIQUE
// key the dedup depends on), so a migration that would fail in production fails here first.
// Relative to this config: __dirname does not exist in an ESM config file.
const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          // Stand-ins for the two production secrets. Obvious fakes on purpose: the alert suite stubs
          // fetch, so a real key would be both useless and a liability in a public repo.
          RESEND_API_KEY: "re_test_not_a_real_key",
          ALERT_TO: "alerts@example.test",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
