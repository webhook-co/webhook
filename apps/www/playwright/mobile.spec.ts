import { expect, test } from "@playwright/test";

import { ALL_NAV_DESTINATIONS } from "../src/components/marketing/nav-links";
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

    // Derived from the same source the menu renders from — a hand-typed list here would drift the
    // moment someone changes the nav, which is the exact failure this whole spec exists to catch.
    const nav = page.getByRole("navigation", { name: "Main" }).last();
    expect(ALL_NAV_DESTINATIONS.length).toBeGreaterThan(3); // non-vacuous
    for (const { label } of ALL_NAV_DESTINATIONS) {
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

test.describe("the surfaces tablist stays one row on a phone", () => {
  /**
   * Four surfaces, one row. The tablist shipped as `flex-wrap` with a "Web app" label, which needs
   * 378px of intrinsic width against the 342px a 390px phone actually offers — so the fourth tab
   * dropped to a second line on every common phone (390, 375, and the very common Android 360), and
   * the "four surfaces" claim read as three-plus-one.
   *
   * The widths are measured, not guessed, and jsdom cannot see any of this: the wrap is pure CSS
   * layout, so it only fails in a real browser at a real width. 360px is the floor because it is a
   * real, extremely common Android viewport — not a hypothetical.
   */
  for (const width of [360, 375, 393]) {
    test(`all four tabs share one row at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");
      await page.getByRole("heading", { level: 1 }).waitFor();

      const tabs = page.getByRole("tab");
      await expect(tabs).toHaveCount(4); // non-vacuous: the assertion below is meaningless with 0 tabs

      const boxes = await tabs.evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return { label: el.textContent?.trim() ?? "", top: Math.round(r.top), right: r.right };
        }),
      );
      const rows = new Set(boxes.map((b) => b.top));
      expect(
        rows.size,
        `the tablist wrapped onto ${rows.size} rows at ${width}px: ${JSON.stringify(boxes)}`,
      ).toBe(1);

      // A single row that runs off the edge is not a fix — it just moves the defect.
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      for (const box of boxes) {
        expect(
          box.right,
          `the "${box.label}" tab overhangs the viewport at ${width}px`,
        ).toBeLessThanOrEqual(clientWidth + 1);
      }
    });
  }
});

test.describe("the /verify tool stays above the fold on a phone", () => {
  // Every result that ranks for "webhook tester" / signature-verification terms is an instant tool,
  // so the one thing this page must not do is make a phone visitor scroll past prose to reach the
  // verifier. The FAQ added beneath it must never push it below the fold. jsdom cannot see this — it
  // is pure layout at a real viewport — so it is pinned here, in a real browser, not with a className.
  test("the verifier is reachable without scrolling, and the FAQ sits below it", async ({
    page,
  }) => {
    const FOLD = 851; // Pixel 5 height
    await page.setViewportSize({ width: 393, height: FOLD });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/verify");
    await page.getByRole("heading", { level: 1 }).waitFor();

    const tool = page.getByRole("form", { name: /webhook signature verifier/i });
    await expect(tool).toBeVisible();
    const toolBox = await tool.boundingBox();
    expect(toolBox, "the verifier has no box").not.toBeNull();
    expect(
      toolBox!.y,
      `the verifier starts at ${Math.round(toolBox!.y)}px, at or below the ${FOLD}px fold`,
    ).toBeLessThan(FOLD);

    // …and the FAQ is strictly beneath the tool — never an article above it.
    const faqBox = await page.locator("#faq").boundingBox();
    expect(faqBox, "the FAQ has no box").not.toBeNull();
    expect(faqBox!.y, "the FAQ sits above the tool").toBeGreaterThan(toolBox!.y);
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
      // Wait on a RENDERED ELEMENT, never `networkidle`: /play loads the Turnstile challenge and holds
      // an SSE connection open, so the network never goes idle and the wait simply times out.
      await page.getByRole("heading", { level: 1 }).first().waitFor();

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
