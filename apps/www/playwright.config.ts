import { defineConfig, devices } from "@playwright/test";

// Real-browser accessibility gate. Serves the built static export (out/) and runs axe-core against
// it in Chromium — the only layer that sees real layout, so the only one that catches color
// contrast, focus appearance, and target size. Reduced motion is emulated so the live inspector
// (and all CSS animation) is still, making every scan deterministic.
const PORT = 4321;
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./playwright",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
  },
  // Reduced motion is emulated per-test via page.emulateMedia() before navigation (the `use`-level
  // setting doesn't reliably apply alongside a spread device descriptor). With it on, the
  // scroll-reveal sections render immediately and the live stream starts paused, so the page is a
  // static, full-opacity target and axe never measures a mid-animation blended color.
  // TWO viewports, not one. Until now every project was Desktop Chrome, so the a11y and link suites
  // had literally never rendered a phone — which is how the site shipped to production with NO mobile
  // navigation at all (the desktop bar is `max-[940px]:hidden`, and nothing was behind it). A guard
  // that cannot see the thing it guards is not a guard.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /mobile\.spec\.ts/, // the burger is correctly absent at desktop width
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 5"] }, // 393×851 — a real, common phone viewport
      // The a11y scan runs HERE TOO, not just on desktop. Mobile is precisely where regions become
      // scrollable and controls get cramped — scanning only the desktop layout means the axe suite
      // has never audited the layout most visitors actually get.
      testMatch: /(mobile|a11y)\.spec\.ts/,
    },
  ],
  webServer: {
    command: "node playwright/serve.mjs",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: { PORT: String(PORT) },
  },
});
