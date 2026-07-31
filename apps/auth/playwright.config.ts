import { defineConfig, devices } from "@playwright/test";

// The auth surface's real-browser gate. A real Chromium against a real PRODUCTION BUILD served by
// `next start` — and, unlike apps/web's e2e, against NO database.
//
// The production build is the load-bearing half: the suite's central assertion is about the CSP, and the
// dev and production policies deliberately differ (see security-headers.ts). Running this against
// `next dev` would exercise the relaxed policy and prove nothing about what ships. See the webServer note
// below for why the build is part of the server command rather than a separate step.
//
// No database is not a shortcut, it is a property of the page: a signed-out visitor's /login render
// touches neither secrets nor Postgres. `isSignedIn()` short-circuits on the absent session cookie before
// it ever builds an auth instance (resolve-signed-in.ts:49), and `socialProvidersForLogin()` catches any
// fault and degrades to the production shape (social-providers.ts:25). So this job needs no Postgres
// service, no dbmate, and no migrations.
//
// PORT 3101, not the app's usual 3001, deliberately. With `reuseExistingServer` on locally, pointing at
// 3001 would silently adopt whatever a developer already had running there — possibly a different app,
// possibly a stale build — and report its behaviour as this suite's result. A dedicated port means the
// server under test is always the one this config started.
const PORT = 3101;
// 127.0.0.1, never localhost. `allowedDevOrigins` does NOT apply here — Next only enforces it under
// `next dev`, and this serves a production build — but the two spellings are still distinct origins to
// the browser, and pinning one keeps this suite consistent with the rest of the dev stack (and with
// docs/local-parity.md's note on the same trap).
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./playwright",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  // A `webServer` block IS correct here (apps/web cannot use one because its server needs a database
  // that globalSetup provisions, which deadlocks against Playwright's readiness wait). This server has
  // no such dependency, so Playwright can own its lifecycle.
  //
  // `next start`, NOT `next dev`, and this is the load-bearing choice in this file. The suite's most
  // valuable assertion is "zero CSP violations", and `next dev` serves the RELAXED policy
  // ('unsafe-eval' + the HMR websocket — see src/security-headers.ts). Running there would check a
  // policy we never ship and would sail straight past a violation that only the production policy
  // produces. Since the entire reason this suite exists is to prove the production CSP survives a real
  // browser before a third-party script lands on this page, it has to exercise the production policy.
  // `test:e2e` runs `next build` first; the phase-based next.config export gives a non-dev build the
  // tight policy. (The dev policy is pinned separately, by unit tests in src/security-headers.test.ts.)
  // The BUILD is part of the server command on purpose. Splitting it into a separate step leaves room for
  // `next start` to serve a stale .next from an earlier run — a suite that reports on code that is no
  // longer in the tree, which is worse than no suite. Building here makes that unrepresentable.
  // (Workspace dependencies must already be built: `turbo run build --filter='@webhook-co/auth^...'`.
  // Without their dist/, tsconfig's paths redirect falls back to source and `next build` typechecks
  // packages/shared under this app's DOM lib, which fails on unrelated BufferSource variance.)
  webServer: {
    command: `pnpm exec next build && pnpm exec next start -p ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
  },

  timeout: 60_000,
  expect: { timeout: 15_000 },
});
