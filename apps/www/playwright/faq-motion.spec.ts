import { expect, test } from "@playwright/test";

/**
 * The FAQ accordion's motion — checked in a real browser, because none of what matters here is
 * visible to jsdom: it has no layout, so it has no height to animate, and no `prefers-reduced-motion`
 * to honour.
 *
 * The close animation is the whole reason this component owns `open` at all. A native <details> hides
 * its children the instant `open` goes false, so a CSS-only accordion can fade IN and can only ever
 * snap SHUT. These tests are what stop someone "simplifying" that back to CSS and silently losing half
 * the animation — and, more importantly, what stop the JS takeover from breaking the accordion for a
 * reader who has JavaScript off or hasn't hydrated yet.
 *
 * These drive the SECOND panel, not the first: on /pricing the first panel is open on load (it carries
 * the billable unit, which must be readable without a click), so clicking it would test the close path
 * when we mean to test the open one.
 */

test.describe("FAQ accordion motion", () => {
  test("opens smoothly: mid-flight the panel is PARTLY open, not already full height", async ({
    page,
  }) => {
    await page.goto("/pricing");
    const first = page.locator("details").nth(1);
    const panel = first.locator("> div");
    await expect(first).not.toHaveAttribute("open", /.*/);

    await first.locator("summary").click();

    // Sample EARLY inside the 280ms open — not on the same tick as the click (that would measure the
    // layout before React's effect had even run, and would pass whether or not anything animated), and
    // not late either: the easing is fast-out, so by 120ms the panel is already ~93% open and the
    // assertion has no margin left. 60ms is comfortably mid-reveal.
    await page.waitForTimeout(60);
    const mid = await panel.evaluate((el) => el.getBoundingClientRect().height);

    await page.waitForTimeout(500);
    const settled = await panel.evaluate((el) => el.getBoundingClientRect().height);

    expect(settled, "the panel never opened").toBeGreaterThan(20);
    expect(mid, "the panel snapped straight to full height — it is not animating").toBeLessThan(
      settled * 0.9,
    );
    expect(mid, "the panel had not started opening at all").toBeGreaterThan(0);
  });

  test("closes smoothly: mid-close the panel is SHRINKING, not already gone", async ({ page }) => {
    await page.goto("/pricing");
    const first = page.locator("details").nth(1);
    const panel = first.locator("> div");

    await first.locator("summary").click();
    await page.waitForTimeout(500);
    const open = await panel.evaluate((el) => el.getBoundingClientRect().height);
    expect(open).toBeGreaterThan(20);

    await first.locator("summary").click();
    // Sample INSIDE the 220ms close. This is the whole reason the component owns `open`: a native
    // <details> hides its children the instant `open` goes false, so if the close were left to the
    // browser this height would already be 0. It must be strictly between 0 and the open height.
    await page.waitForTimeout(110);
    const mid = await panel.evaluate((el) => el.getBoundingClientRect().height);

    expect(mid, "the panel snapped shut — the close is not animated").toBeGreaterThan(0);
    expect(mid, "the panel had not started closing at all").toBeLessThan(open * 0.95);

    await expect(first).not.toHaveAttribute("open", /.*/, { timeout: 2000 });
  });

  test("stays EXCLUSIVE — opening one closes the other", async ({ page }) => {
    await page.goto("/pricing");
    const items = page.locator("details");
    // The first panel is already open on load (the billable unit). Opening the second must close it.
    await expect(items.nth(0)).toHaveAttribute("open", /.*/);

    await items.nth(1).locator("summary").click();
    await page.waitForTimeout(500);
    await expect(items.nth(1)).toHaveAttribute("open", /.*/);
    await expect(items.nth(0), "two panels were open at once").not.toHaveAttribute("open", /.*/);

    await items.nth(2).locator("summary").click();
    await page.waitForTimeout(500);
    await expect(items.nth(2)).toHaveAttribute("open", /.*/);
    await expect(items.nth(1), "two panels were open at once").not.toHaveAttribute("open", /.*/);
  });

  test("honours prefers-reduced-motion: NO animation is started at all", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/pricing");

    const first = page.locator("details").nth(1);
    const panel = first.locator("> div");
    await first.locator("summary").click();

    // ⚠️ HONESTY: this asserts the OUTCOME (nothing animates under reduced motion), and it is NOT a
    // guard on our own `prefersReducedMotion()` check — mutation-checked: it still passes with that
    // check disabled, because Chromium/motion already finish the animation instantly when the media
    // query is set. Nothing observable can distinguish the two, so no test can. Our check stays
    // because relying on that browser/library behaviour is not something we control; just don't read
    // this as proof that it fires.
    //
    // (Height cannot answer this at all: 120ms into a 280ms fast-out reveal the panel is already near
    // full height, so a height probe passes whether or not the animation ran — also mutation-checked.)
    await page.waitForTimeout(60);
    const running = await panel.evaluate((el) => el.getAnimations().length);
    expect(running, "reduced-motion still started an animation").toBe(0);

    // …and it must still be open. Honouring the preference means instant, not broken.
    await expect(first).toHaveAttribute("open", /.*/);
    const height = await panel.evaluate((el) => el.getBoundingClientRect().height);
    expect(height, "reduced-motion left the panel collapsed").toBeGreaterThan(20);
  });

  test("the answers are in the static HTML — a crawler and a no-JS reader still get them", async ({
    request,
  }) => {
    // Fetched WITHOUT a browser: no JS runs at all. The FAQPage schema promises these answers exist,
    // so they must be in the served markup, not mounted on open.
    const html = await (await request.get("/pricing")).text();
    expect(html).toContain("A request we capture is one event");
    expect(html).toMatch(/<details name="[^"]+"/);
    // Exactly ONE panel is open in the static markup: the billable unit. Not zero (the constitution
    // requires it readable without a click), and not several (it is an accordion).
    expect((html.match(/<details[^>]*\sopen/g) ?? []).length).toBe(1);
  });
});
