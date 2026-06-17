import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// WCAG 2.0/2.1/2.2 A + AA. This is the only layer that sees real layout, so the only one that
// catches color contrast (1.4.3) — e.g. the dark terminal's dim text and the monochrome gray ramp.
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

// Emulate reduced motion BEFORE navigating, so the app's useScrollReveal shows every section
// immediately (no opacity fade) and the live stream starts paused. The page is then a static,
// full-opacity target — axe measures final colors, with no animation to race against.
async function settle(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("group", { name: /live webhook inspector/i }).waitFor();
}

async function expectClean(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  // Map to a readable shape so a failure prints the rule + offending selector + contrast detail.
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

test.describe("homepage accessibility (real browser)", () => {
  test.beforeEach(async ({ page }) => {
    await settle(page);
  });

  test("default state has no violations", async ({ page }) => {
    await expectClean(page);
  });

  test("no violations with each nav dropdown open", async ({ page }) => {
    for (const name of [/^product$/i, /^developers$/i]) {
      await page.getByRole("button", { name }).click();
      await expectClean(page);
      await page.keyboard.press("Escape");
    }
  });

  test("no violations on each surface tab (covers all four dark terminals)", async ({ page }) => {
    for (const name of ["MCP", "CLI", "API", "Web app"]) {
      const tab = page.getByRole("tab", { name, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expectClean(page);
    }
  });
});
