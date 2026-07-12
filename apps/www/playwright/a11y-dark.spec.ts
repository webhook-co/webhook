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
 * Dark is selected the way a real first-time visitor gets it: `colorScheme: dark` on the media query,
 * which the pre-paint `themeInitScript` reads (no stored preference → follow the OS) and stamps onto
 * <html data-theme>. So this exercises the actual init path, not a hand-set attribute.
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
  for (const path of a11yRoutes()) {
    test(`${path} has no violations in dark mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).first().waitFor();

      // Non-vacuous: prove we are ACTUALLY in dark before trusting a clean scan. Without this, a
      // broken init script would give a green "dark" suite that never left light mode.
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

      await expectClean(page);
    });
  }
});
