import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// apps/auth runs TWO test suites from a single `vitest run` (the `test` script CI invokes via
// `turbo run test`), as separate Vitest projects so each gets the right runtime:
//
//   • jsdom    — the client-component suite (login-form validation, the mock auth-action seam),
//                jsdom + Testing Library, mirroring apps/web. Excludes *.workers.test.ts.
//   • workers  — a workerd boot-smoke that constructs the REAL @cloudflare/workers-oauth-provider
//                OAuthProvider from the SAME oauthIssuerConfig the Worker entry uses and asserts
//                RFC 8414 discovery responds. The jsdom gate + `deploy:dry` (bundle-only) can't
//                catch a provider-ctor throw — only real workerd can (the A2b-5 `apiHandlers: {}`
//                fix exists because the ctor once threw without it). Matches *.workers.test.ts.
//
// Splitting by environment (not just by file glob) is required: the jsdom suite needs the React
// plugin + jsdom, the workers suite needs the @cloudflare/vitest-pool-workers pool + miniflare.
// Running a single project across both is impossible — they're different runtimes.
//
// Coverage is collected but NOT threshold-gated (most of apps/auth is page composition over the
// @webhook-co/ui primitives — we test the components that carry logic, not page markup).
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react()],
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
            // The `server-only` marker throws outside a server build; stub it so server-only
            // modules (the consent ticket resolver) are importable under vitest.
            "server-only": fileURLToPath(new URL("./test/server-only-stub.ts", import.meta.url)),
          },
        },
        test: {
          name: "jsdom",
          globals: true,
          environment: "jsdom",
          setupFiles: ["./vitest.setup.ts"],
          include: ["src/**/*.test.{ts,tsx}"],
          // The workerd boot-smoke runs in the `workers` project below (it imports
          // `cloudflare:workers`, which only resolves under the workers pool).
          exclude: ["src/**/*.workers.test.ts"],
        },
      },
      {
        plugins: [
          cloudflareTest({
            miniflare: {
              // The OAuth issuer config imports @webhook-co/db (for API_RESOURCE), whose barrel
              // wires postgres.js — its module eval needs Node built-ins in workerd, same as the
              // mcp resource-server pool. Compat date mirrors apps/auth's wrangler.jsonc.
              compatibilityDate: "2026-06-15",
              // Mirror apps/auth's wrangler.jsonc compat flags so the provider boots under the same
              // runtime shape it ships with (global_fetch_strictly_public also enables CIMD, which
              // the provider warns about otherwise).
              compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
              // OAUTH_KV — the provider's mandatory grant/token/DCR store. Discovery (the metadata
              // path the smoke test hits) doesn't read it, but the real config expects it bound, so
              // we provide it for parity (and so the ctor + provider impl see the same shape as prod).
              kvNamespaces: ["OAUTH_KV"],
            },
          }),
        ],
        test: {
          name: "workers",
          include: ["src/**/*.workers.test.ts"],
        },
      },
    ],
  },
});
