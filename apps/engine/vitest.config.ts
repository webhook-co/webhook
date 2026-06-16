import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Runs the engine's tests inside the real Workers runtime (workerd) via Miniflare,
// so Durable Object / Workers behavior is exercised against the actual runtime.
// (Vitest 4 API: configure the pool via the `cloudflareTest` plugin.)
//
// Test-only secret values (never real keys): 32 zero-bytes base64 satisfies the length checks the
// cursor / pepper / audit-key importers enforce. The LISTEN_SESSION DO imports CURSOR_KEY in its
// constructor and the listen-upgrade bearer chain reads CREDENTIAL_PEPPER, so both must be present;
// tests read CURSOR_KEY back from the same env to forge cursors that the DO verifies. Real values are
// injected as Worker secrets at deploy (never committed — no-secrets).
const TEST_KEY_32 = Buffer.alloc(32).toString("base64");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          CURSOR_KEY: TEST_KEY_32,
          CREDENTIAL_PEPPER: TEST_KEY_32,
          AUDIT_CHAIN_HMAC_KEY: TEST_KEY_32,
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
