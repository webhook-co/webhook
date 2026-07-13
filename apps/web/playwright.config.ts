import { defineConfig, devices } from "@playwright/test";

import { BASE_URL } from "./playwright/fixture";

// The dashboard's end-to-end gate: a real Chromium against a real `next dev` against a real Postgres.
//
// The unit suite (vitest.config.ts, jsdom) mocks the auth gate, and the server-action suite asserts that
// `revalidatePath` was called with a path string. Neither can see a page that reads the acting org from the
// wrong place, or a cache invalidation aimed at a route that no longer exists. This is the layer that can.
//
// Serial, single worker: every spec shares one seeded database and one dev server, and the specs mutate it
// (creating endpoints, changing roles). Parallelism here would buy seconds and cost determinism.
export default defineConfig({
  testDir: "./playwright",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  globalSetup: "./playwright/global-setup.ts",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  // No `webServer` block, deliberately. Playwright starts `webServer` and waits for it to answer BEFORE it
  // runs globalSetup — so a server that needs the database globalSetup provisions can never become healthy,
  // and the run deadlocks. globalSetup spawns `next dev` itself (see the comment there).

  // A cold `next dev` compiles each route on first request, so the first navigation in a spec is slow.
  timeout: 60_000,
  expect: { timeout: 15_000 },
});
