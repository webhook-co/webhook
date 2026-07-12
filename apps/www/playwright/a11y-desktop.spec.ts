import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Accessibility checks for controls that exist ONLY at desktop width.
 *
 * The Product dropdown is one: below 940px the nav collapses into the burger, so the dropdown button
 * isn't in the DOM at all and a test for it would simply time out on a phone.
 *
 * It lives in its own FILE rather than behind a `test.skip`, because this repo forbids skipped tests
 * (AGENTS.md) — and rightly: a skip is invisible in a green run, so a test that quietly stops
 * executing looks exactly like a test that passes. Scoping by file means the desktop project runs it
 * and the mobile project never collects it, with nothing skipped anywhere.
 *
 * The burger's own open/closed a11y is covered by `mobile.spec.ts`.
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

test.describe("desktop-only nav controls", () => {
  test("no violations with the Product nav dropdown open", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.getByRole("heading", { level: 1 }).waitFor();

    // The IA lane left a single dropdown (Product → www pages); Developers was removed.
    const trigger = page.getByRole("button", { name: /^product$/i });
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expectClean(page);

    await page.keyboard.press("Escape");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
