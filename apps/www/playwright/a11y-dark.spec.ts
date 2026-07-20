import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { a11yRoutes } from "../src/lib/routes";

/**
 * The axe scan again — in DARK MODE.
 *
 * Adding a theme toggle doubles the number of colour combinations the site ships, and contrast is the
 * one a11y rule that a second theme can break wholesale and silently: every token pair is different.
 * Scanning only the light layout after shipping a dark one would leave half the site unaudited.
 *
 * Dark is selected the way it ships: a stored `wh-theme=dark` preference — equivalently, the product's
 * own default — which the pre-paint `themeInitScript` reads and stamps onto <html data-theme> before
 * paint. So this exercises the real init path, not a hand-set attribute.
 */

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function expectClean(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    violations.map((v) => ({
      id: v.id,
      help: v.help,
      nodes: v.nodes.map(
        (n) => `${n.target.join(" ")} — ${n.failureSummary?.split("\n").pop()?.trim()}`,
      ),
    })),
  ).toEqual([]);
}

test.describe("page accessibility in dark mode", () => {
  // Stamp the dark preference before any navigation, so the pre-paint script resolves dark regardless
  // of the OS. The `data-theme="dark"` assertion below stays the non-vacuous guard that we really are
  // in dark before trusting a clean scan.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem("wh-theme", "dark");
      } catch {
        /* opaque origin — ignore */
      }
    });
  });

  for (const path of a11yRoutes()) {
    test(`${path} has no violations in dark mode`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).first().waitFor();

      // Non-vacuous: prove we are ACTUALLY in dark before trusting a clean scan. Without this, a
      // broken init script would give a green "dark" suite that never left light mode.
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

      await expectClean(page);
    });
  }
});
