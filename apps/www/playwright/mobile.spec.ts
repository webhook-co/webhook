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

test.describe("the primary CTA is not buried in the burger", () => {
  /**
   * The one action the site is asking for was reachable ONLY by opening the menu on a phone.
   *
   * The header CTA was `max-[940px]:hidden`, and the homepage hero deliberately carries no sign-up
   * button — its source comment justifies that by saying "the nav's 'Get started' button is the same
   * door, in view on the same screen", which was simply false below 940px. So a phone visitor's only
   * route to an account was: notice the burger → open it → scroll the panel. NN/g measured hidden
   * navigation at roughly HALF the discoverability of visible navigation, +2.5s task time and +15%
   * perceived difficulty — and of everything in a nav, the conversion CTA is the worst thing to hide.
   *
   * The header is `sticky top-0`, so this also makes the CTA persistent at every scroll depth on
   * every page, which a hero button could never be.
   *
   * 320px (iPhone SE 1st gen) is the floor: the bar must fit there too, not merely at 393.
   */
  for (const width of [320, 340, 360, 375, 393, 430]) {
    test(`"Get started" is visible without opening the menu at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 851 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");
      await page.getByRole("heading", { level: 1 }).waitFor();

      // The burger is CLOSED — that is the whole point of this assertion.
      await expect(page.getByRole("button", { name: /open menu/i })).toBeVisible();

      const cta = page.locator(".site-nav").getByRole("link", { name: /get started/i });
      await expect(cta).toBeVisible();

      const box = (await cta.boundingBox())!;
      expect(box, "the CTA has no box").not.toBeNull();
      expect(box.x, `the CTA starts off-screen at ${Math.round(box.x)}px`).toBeGreaterThanOrEqual(
        0,
      );
      expect(
        box.x + box.width,
        `the CTA's right edge is at ${Math.round(box.x + box.width)}px in a ${width}px viewport`,
      ).toBeLessThanOrEqual(width + 1);
      // WCAG 2.5.8 target size (AA) is 24×24; the bar's own icon buttons are 34px, so hold that line.
      expect(
        box.height,
        "the CTA is too short to be a comfortable tap target",
      ).toBeGreaterThanOrEqual(32);
    });

    test(`the header bar still fits its own padding at ${width}px`, async ({ page }) => {
      /**
       * Adding a control to a bar that was already full is how you push the burger off the edge.
       *
       * The naive check — `scrollWidth <= clientWidth` — is NOT enough, and proved it: at 320px the
       * bar overflowed by exactly 1px, sat inside a 1px tolerance, and passed while the burger was
       * clipped by the viewport and the wordmark was jammed flush against the CTA. A flex row that
       * has run out of room does not report a large overflow; it reports a hairline one and quietly
       * eats its own padding. So measure what actually matters: the gutter, and the gaps.
       */
      await page.setViewportSize({ width, height: 851 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");
      await page.getByRole("heading", { level: 1 }).waitFor();

      const bar = await page.evaluate(() => {
        const el = document.querySelector(".site-nav > div") as HTMLElement;
        const box = (sel: string) => {
          const n = el.querySelector(sel) as HTMLElement | null;
          if (!n) return null;
          const r = n.getBoundingClientRect();
          return { left: r.left, right: r.right };
        };
        const cs = getComputedStyle(el);
        return {
          padLeft: parseFloat(cs.paddingLeft),
          padRight: parseFloat(cs.paddingRight),
          clientWidth: el.clientWidth,
          wordmark: box("a[aria-label*='home']"),
          cta: box("a[href='https://app.webhook.co']"),
          burger: box("button[aria-label='Open menu']"),
        };
      });

      expect(bar.wordmark, "no wordmark in the bar").not.toBeNull();
      expect(bar.cta, "no CTA in the bar").not.toBeNull();
      expect(bar.burger, "no burger in the bar").not.toBeNull();

      // The gutter is real: the last control must stop before the bar's own right padding, not run
      // into it and off the screen.
      expect(
        bar.burger!.right,
        `the burger reaches ${Math.round(bar.burger!.right)}px, past the ${bar.padRight}px gutter of a ${bar.clientWidth}px bar`,
      ).toBeLessThanOrEqual(bar.clientWidth - bar.padRight + 1);
      expect(
        bar.wordmark!.left,
        "the wordmark starts inside the left gutter",
      ).toBeGreaterThanOrEqual(bar.padLeft - 1);

      // Controls need daylight between them. Touching at exactly 0px is what "webhook.co" looked
      // like with a white button parked on its final glyph.
      expect(
        bar.cta!.left - bar.wordmark!.right,
        `only ${Math.round(bar.cta!.left - bar.wordmark!.right)}px between the wordmark and the CTA at ${width}px`,
      ).toBeGreaterThanOrEqual(8);
      expect(
        bar.burger!.left - bar.cta!.right,
        `only ${Math.round(bar.burger!.left - bar.cta!.right)}px between the CTA and the burger at ${width}px`,
      ).toBeGreaterThanOrEqual(6);
    });
  }

  test("the theme toggle is still reachable on a phone", async ({ page }) => {
    // Making room for the CTA moved this control into the menu — moved, not dropped. A preference
    // that exists on desktop and silently vanishes on a phone is a parity defect, not a trade-off.
    await page.setViewportSize({ width: 393, height: 851 });
    await page.goto("/");
    await page.getByRole("button", { name: /open menu/i }).click();
    await expect(page.getByRole("button", { name: /switch to (light|dark) theme/i })).toBeVisible();
  });

  test("exactly one theme toggle is exposed at any width", async ({ page }) => {
    // Rendering it in both the bar and the panel would double it in the a11y tree.
    await page.setViewportSize({ width: 393, height: 851 });
    await page.goto("/");
    await page.getByRole("button", { name: /open menu/i }).click();
    await expect(page.getByRole("button", { name: /switch to (light|dark) theme/i })).toHaveCount(
      1,
    );
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

test.describe("the hero inspector fits the phone it renders on", () => {
  /**
   * The card grew WIDER THAN THE VIEWPORT whenever a failed row was on screen, and nothing caught it.
   *
   * The hero grid declared columns only at `min-[940px]`, so below that the row landed in an IMPLICIT
   * column — which is `auto`-sized, i.e. floored at its content's min-content width. A failed row's
   * status line ("✕ failed — timestamp too old" + latency + Replay) is `white-space: nowrap`, so that
   * floor was 379px inside a 345px container: the card ran 10px past the right edge of a 393px phone.
   * `product-shell.tsx` already carries this exact fix (`grid-cols-1` = `repeat(1, minmax(0,1fr))`
   * plus `min-w-0` on the items); the homepage hero never got it.
   *
   * The sideways-scroll guard below could NOT see this: the hero section is `overflow-hidden`, so the
   * overhang was clipped and `document.scrollWidth` stayed exactly 393. A card that silently loses its
   * right edge is not "no overflow" — so this measures the CARD, not the document.
   *
   * 320px is the floor because it is the narrowest viewport still in real use (iPhone SE 1st gen).
   */
  for (const width of [320, 360, 375, 393]) {
    test(`the inspector stays inside a ${width}px viewport`, async ({ page }) => {
      await page.setViewportSize({ width, height: 851 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");
      await page.getByRole("heading", { level: 1 }).waitFor();

      const card = page.getByRole("group", { name: /demo webhook inspector/i });
      await expect(card).toBeVisible();

      // NON-VACUOUS: the overflow only happens when a failed row is on screen, so a run where the
      // seed frame showed nothing but "verified" would pass while proving nothing.
      await expect(card.getByText(/failed —/)).not.toHaveCount(0);

      const box = await card.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, clientWidth: document.documentElement.clientWidth };
      });
      expect(
        box.right,
        `the inspector's right edge is at ${Math.round(box.right)}px in a ${box.clientWidth}px viewport`,
      ).toBeLessThanOrEqual(box.clientWidth + 1);
      expect(
        box.left,
        `the inspector's left edge is at ${Math.round(box.left)}px`,
      ).toBeGreaterThanOrEqual(-1);
    });
  }

  test("no row can push the hero grid past its container", async ({ page }) => {
    // The card is clipped by the hero's `overflow-hidden`, so the honest measure of "did the content
    // blow the layout out" is the GRID's own scrollWidth against the width it was given.
    await page.setViewportSize({ width: 393, height: 851 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.getByRole("heading", { level: 1 }).waitFor();

    const grid = await page
      .getByRole("group", { name: /demo webhook inspector/i })
      .evaluate((el) => {
        const g = el.parentElement!.parentElement!;
        return { scrollWidth: g.scrollWidth, clientWidth: g.clientWidth };
      });
    expect(
      grid.scrollWidth,
      `the hero grid holds ${grid.scrollWidth}px of content in a ${grid.clientWidth}px track`,
    ).toBeLessThanOrEqual(grid.clientWidth + 1);
  });
});

test.describe("no page scrolls sideways on a phone", () => {
  /**
   * A horizontally-scrolling BODY is the classic mobile defect: one wide element (a terminal, a
   * table, a long unbroken string) pushes the whole layout out and every line of text goes
   * off-screen. Wide content is allowed to scroll — but INSIDE its own container, never by dragging
   * the page with it.
   *
   * THREE WIDTHS, NOT ONE. This ran only at the project's Pixel 5 default (393px) and was therefore
   * blind to anything that happens to fit at exactly that width: `/test/github` (372px),
   * `/test/calendly` (381px) and `/test/notion` (345px) all dragged the page sideways on a narrower
   * phone and this guard reported green on every run. A viewport-sensitive check pinned to a single
   * viewport is not a guard against layout, it is a guard against one phone.
   *
   * 320px is the floor (iPhone SE 1st gen); 360px is the most common Android width, and the width
   * that actually caught the tutorial-prose defect.
   */
  for (const width of [320, 360, 393]) {
    for (const path of pages) {
      test(`${path} does not overflow horizontally at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 851 });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto(path);
        // Wait on a RENDERED ELEMENT, never `networkidle`: /play loads the Turnstile challenge and
        // holds an SSE connection open, so the network never goes idle and the wait simply times out.
        await page.getByRole("heading", { level: 1 }).first().waitFor();

        const overflow = await page.evaluate(() => {
          const doc = document.documentElement;
          return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
        });
        // 1px of tolerance for sub-pixel rounding; anything more is a real overflow.
        expect(
          overflow.scrollWidth,
          `${path} scrolls sideways at ${width}px (${overflow.scrollWidth}px content in a ${overflow.clientWidth}px viewport)`,
        ).toBeLessThanOrEqual(overflow.clientWidth + 1);
      });
    }
  }
});
