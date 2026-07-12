import { expect, test } from "@playwright/test";

import { a11yRoutes } from "../src/lib/routes";

/**
 * What the desktop-only Playwright suite could never see.
 *
 * The site shipped to production with NO navigation on a phone: the desktop bar is
 * `max-[940px]:hidden` and nothing was behind it, so below 940px a visitor got a logo, a "Get started"
 * button, and no way to reach Product, Pricing, About or Docs. Fifty green Playwright checks did not
 * notice, because every project was `Desktop Chrome`.
 *
 * This file runs ONLY in the `mobile` project (Pixel 5); the desktop project ignores it, because at
 * desktop width the burger is correctly absent. Scoped in playwright.config.ts, not with a skip.
 */

const pages = a11yRoutes(); // already the path strings

test.describe("mobile navigation", () => {
  test("the whole navigation is reachable from the burger", async ({ page }) => {
    await page.goto("/");

    // The desktop bar is hidden here — that's the point. The burger is what must exist.
    const burger = page.getByRole("button", { name: /open menu/i });
    await expect(burger).toBeVisible();
    await burger.click();

    const nav = page.getByRole("navigation", { name: "Main" }).last();
    for (const label of [
      "Capture & replay",
      "Verification",
      "Delivery",
      "Agent triggers",
      "Pricing",
      "About",
      "Docs",
    ]) {
      await expect(nav.getByRole("link", { name: label })).toBeVisible();
    }
  });

  test("the burger menu actually navigates", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /open menu/i }).click();
    // Scoped to the menu: "Pricing" also lives in the footer.
    const menu = page.getByRole("navigation", { name: "Main" }).last();
    await menu.getByRole("link", { name: "Pricing" }).click();
    await page.waitForURL(/\/pricing$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("Escape closes the menu", async ({ page }) => {
    await page.goto("/");
    const burger = page.getByRole("button", { name: /open menu/i });
    await burger.click();
    await expect(page.getByRole("button", { name: /close menu/i })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: /open menu/i })).toBeVisible();
  });
});

test.describe("no page scrolls sideways on a phone", () => {
  // A horizontally-scrolling BODY is the classic mobile defect: one wide element (a terminal, a table,
  // a long unbroken string) pushes the whole layout out and every line of text goes off-screen. Wide
  // content is allowed to scroll — but INSIDE its own container, never by dragging the page with it.
  for (const path of pages) {
    test(`${path} does not overflow horizontally`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(path);
      await page.waitForLoadState("networkidle");

      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
      });
      // 1px of tolerance for sub-pixel rounding; anything more is a real overflow.
      expect(
        overflow.scrollWidth,
        `${path} scrolls sideways (${overflow.scrollWidth}px content in a ${overflow.clientWidth}px viewport)`,
      ).toBeLessThanOrEqual(overflow.clientWidth + 1);
    });
  }
});
