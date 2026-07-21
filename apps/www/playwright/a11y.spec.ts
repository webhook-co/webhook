import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { BILLABLE_UNIT, BILLING_TERMS } from "../src/components/marketing/faq";
import { a11yRoutes } from "../src/lib/routes";

// WCAG 2.0/2.1/2.2 A + AA. This is the only layer that sees real layout, so the only one that
// catches color contrast (1.4.3) — e.g. the dark terminal's dim text and the monochrome gray ramp.
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

// Emulate reduced motion BEFORE navigating, so the app's useScrollReveal shows every section
// immediately (no opacity fade) and the live stream starts paused. The page is then a static,
// full-opacity target — axe measures final colors, with no animation to race against.
async function settle(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("group", { name: /demo webhook inspector/i }).waitFor();
}

async function expectClean(page: Page) {
  // Non-vacuous guard: prove the light seed actually took effect. Without this, a broken seed would let
  // every page render in the DARK default and this "light" contrast pass would go green while auditing
  // the wrong palette (mirrors the data-theme="dark" assert in a11y-dark.spec.ts).
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
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

// The product defaults to DARK. This suite is the LIGHT-mode audit (dark is covered by
// a11y-dark.spec.ts), so pin a stored light preference before any navigation — otherwise every page
// here would render dark and this light contrast pass would silently stop auditing light mode.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("wh-theme", "light");
    } catch {
      /* opaque origin — ignore */
    }
  });
});

// EVERY human-facing page, DERIVED from the route manifest (`a11y: true`) — including `/` and
// `/pricing`. Coverage is coupled to the manifest, not to a hand-maintained exclusion list: a new
// /about or /product/* page is axe-scanned the moment it joins the manifest, and no page can silently
// drop out of scanning because someone removed a bespoke describe. The homepage and /pricing DO keep
// extra bespoke describes below (interactive states, disclosures); this baseline pass is deliberate
// redundancy for their default state — the cheap price of a manifest-coupled guarantee.
//
// This is the only layer that sees real layout, so the only one that catches color contrast (1.4.3)
// and target size (2.5.8) — jsdom cannot. The legal pages are also where the section anchors live.
const SCANNED_PAGES = a11yRoutes();

test.describe("page accessibility (real browser, manifest-driven)", () => {
  // A guard on the guard: if the manifest ever yields nothing, this suite would pass while scanning
  // zero pages — that looks like coverage but is none.
  test("the manifest yields pages to scan", () => {
    expect(SCANNED_PAGES.length).toBeGreaterThan(0);
  });

  for (const path of SCANNED_PAGES) {
    test(`${path} has no violations`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).waitFor();
      // The homepage's live demo is an SSR'd, reduced-motion-paused island — wait for it so axe sees
      // the settled page, not a mid-hydration frame.
      if (path === "/") {
        await page.getByRole("group", { name: /demo webhook inspector/i }).waitFor();
      }
      await expectClean(page);
    });
  }
});

test.describe("legal section anchors", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/terms");
  });

  // The hover-reveal trap: an affordance a keyboard user can never summon. jsdom can only assert the
  // class is present; a real browser is the only place we can prove the glyph actually computes to
  // visible.
  //
  // Focus has to arrive by KEYBOARD. Chromium sets `:focus-visible` from the input modality, not from
  // the fact of focus — a programmatic `.focus()` leaves it unset, so asserting against that would
  // test nothing and fail. Landing focus with a real Tab keypress is both the honest test and exactly
  // what the user does.
  test("reveals the # on keyboard focus, not just hover", async ({ page }) => {
    const link = page.getByRole("link", { name: "9. Limitation of liability" });
    const glyph = link.locator('[aria-hidden="true"]');

    await expect(glyph).toHaveCSS("opacity", "0");

    await link.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab"); // a genuine keyboard interaction → :focus-visible

    await expect(link).toBeFocused();
    await expect(glyph).toHaveCSS("opacity", "1");
  });

  // The affordance must not be left stranded on screen for a mouse user who clicked through — that
  // is the whole reason this is :focus-visible and not :focus.
  test("does not strand the # visible after a mouse click", async ({ page }) => {
    const link = page.getByRole("link", { name: "10. Indemnification" });
    await link.click();
    await page.mouse.move(0, 0); // focus arrived by pointer, so nothing should persist
    await expect(link.locator('[aria-hidden="true"]')).toHaveCSS("opacity", "0");
  });

  // LegalDoc's prose-link rule is a descendant selector, so it OUTRANKS the classes on the link
  // itself — `no-underline` on the element loses to `[&_a]:underline` on an ancestor. It underlined
  // every section title and knocked it from semibold (620) to medium (500), and jsdom happily passed
  // it: the class was present, the cascade just ignored it. Only a computed style catches this.
  test("a heading permalink still looks like a heading, not a prose link", async ({ page }) => {
    const link = page.locator("#limitation-of-liability a");
    await expect(link).toHaveCSS("text-decoration-line", "none");
    await expect(link).toHaveCSS("font-weight", "620");
  });

  // …while links in the prose itself keep their underline. The fix must not overshoot.
  test("links inside the prose are still underlined", async ({ page }) => {
    const proseLink = page.locator("article p a").first();
    await expect(proseLink).toHaveCSS("text-decoration-line", "underline");
  });

  test("clicking a heading puts the section in the URL", async ({ page }) => {
    await page.getByRole("link", { name: "9. Limitation of liability" }).click();
    await expect(page).toHaveURL(/#limitation-of-liability$/);
  });

  // The path that actually matters: someone opens a link pasted into a contract. If the sticky nav
  // covers the heading they land on, the citation points at the wrong thing (WCAG 2.4.11).
  test("a cold load with the fragment lands the section clear of the sticky nav", async ({
    page,
  }) => {
    await page.goto("/terms#limitation-of-liability");

    const heading = page.locator("#limitation-of-liability");
    await expect(heading).toBeVisible();

    const headingBox = await heading.boundingBox();
    const navBox = await page.locator(".site-nav").boundingBox();
    expect(headingBox!.y).toBeGreaterThanOrEqual(navBox!.y + navBox!.height);
  });

  // THE REGRESSION GUARD. Declaring `scroll-behavior: smooth` on the root makes Chrome drop the
  // load-time fragment scroll entirely — the page just sits at the top, and every pasted contract
  // link silently stops working. Smooth is therefore gated behind the first interaction, and this
  // asserts the gate holds: on a cold load the document must ALREADY be scrolled, with no animation
  // still in flight.
  test("a cold load jumps instantly — smooth scrolling must not swallow the fragment", async ({
    page,
  }) => {
    await page.goto("/terms#limitation-of-liability");

    const settled = await page.evaluate(() => window.scrollY);
    expect(settled, "the cold load never scrolled to the fragment").toBeGreaterThan(1000);

    // Nothing may still be gliding: sample twice and require stillness.
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.scrollY)).toBe(settled);

    // And smooth must be OFF until the reader touches the page.
    expect(
      await page.evaluate(() => document.documentElement.classList.contains("smooth-scroll")),
    ).toBe(false);
  });

  test("clicking a heading glides, and marks the section you landed on", async ({ page }) => {
    await page.goto("/terms");

    const link = page.getByRole("link", { name: "9. Limitation of liability" });
    await link.click();

    // The click itself (capture phase) turns smooth on, so this very navigation animates.
    expect(
      await page.evaluate(() => document.documentElement.classList.contains("smooth-scroll")),
    ).toBe(true);
    await expect(page).toHaveURL(/#limitation-of-liability$/);

    // :target drives the landing highlight — assert the browser actually matches it.
    expect(
      await page.evaluate(() =>
        document.getElementById("limitation-of-liability")?.matches(":target"),
      ),
    ).toBe(true);
  });
});

test.describe("pricing page accessibility (real browser)", () => {
  test("no violations, in both the default and fully-expanded state", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/pricing");
    await expectClean(page);

    // A native <details> changes the a11y tree when it opens; scan the expanded state too.
    await page.getByText("Are retries billed?").click();
    await expectClean(page);
  });

  // AGENTS.md: pricing must be "disclosed UP FRONT … on the pricing page". The MUST-disclose items
  // render <details open> precisely so a buyer cannot miss them, and this is the only layer that can
  // prove a reader actually SEES them — jsdom knows the `open` attribute, a browser knows pixels.
  //
  // `toBeVisible()` is NOT enough here and asserting it would be self-deception: Playwright's
  // visibility check ignores OPACITY, and <Reveal> paints its children at `opacity: 0` until an
  // IntersectionObserver fires — as does the `faqOpen` keyframe's first frame. A regression that
  // painted the disclosures invisible would sail straight through. So assert the computed opacity.
  //
  // AGENTS.md names exactly ONE thing that must be disclosed up front on this page: "the billable unit
  // — every captured request to an endpoint". It is the FIRST FAQ, and the first panel is open on
  // load, so it is readable without a click. That is the strict guard.
  //
  // Playwright's toBeVisible() ignores OPACITY, and <Reveal> paints its children at `opacity: 0` until
  // an IntersectionObserver fires — a regression that painted the disclosure invisible would sail
  // straight through it. So the computed opacity is asserted up the whole ancestor chain.
  test("the BILLABLE UNIT is readable without a click", async ({ page }) => {
    await page.goto("/pricing");
    const el = page.getByText(BILLABLE_UNIT).first();
    await expect(el, "the pricing page never states the billable unit").toBeVisible();

    const inClosedPanel = await el.evaluate((node) => {
      const d = (node as Element).closest("details");
      return d ? !d.open : false;
    });
    expect(
      inClosedPanel,
      "the billable unit is hidden behind a click — that is not 'up front'",
    ).toBe(false);

    const effectiveOpacity = await el.evaluate((node) => {
      let opacity = 1;
      for (let n: Element | null = node; n; n = n.parentElement) {
        opacity *= Number(getComputedStyle(n).opacity);
      }
      return opacity;
    });
    expect(effectiveOpacity, "the billable unit is present but painted invisible").toBeGreaterThan(
      0.9,
    );
  });

  // The remaining billing terms are STATED on the page (and carried in the FAQPage schema), but sit
  // one click away in the accordion — a deliberate founder decision, taken over an earlier
  // implementation that forced five panels open. So this asserts PRESENCE, not openness. If someone
  // deletes one, the page stops saying something it promises to say, and this goes red.
  test("every other billing term is still stated on the pricing page", async ({ page }) => {
    await page.goto("/pricing");
    expect(BILLING_TERMS.length, "the billing-terms contract is empty").toBeGreaterThan(0);
    for (const { what, needle } of BILLING_TERMS) {
      await expect(
        page.getByText(needle).first(),
        `the pricing page never states: ${what}`,
      ).toBeAttached();
    }
  });

  // Both tier overage lines must set on one line in the card.
  test("the tier overage lines set on one line", async ({ page }) => {
    await page.goto("/pricing");

    for (const copy of ["No overage. Capture pauses.", "€25 per extra million events"]) {
      const line = page.getByText(copy, { exact: true }).first();
      await expect(line).toBeVisible();
      const box = await line.boundingBox();
      expect(box!.height, `"${copy}" wrapped to two lines`).toBeLessThan(30);
    }
  });
});

test.describe("homepage accessibility (real browser)", () => {
  test.beforeEach(async ({ page }) => {
    await settle(page);
  });

  test("default state has no violations", async ({ page }) => {
    await expectClean(page);
  });

  test("no violations on each surface tab (covers all four dark terminals)", async ({ page }) => {
    for (const name of ["MCP", "CLI", "API", "Web"]) {
      const tab = page.getByRole("tab", { name, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expectClean(page);
    }
  });
});

// The provider picker on /verify is a popover listbox of 122 options, each with a brand mark — the
// same shared Combobox the dashboard uses. The manifest-driven sweep above only ever sees it CLOSED,
// so the state this control exists for would go unaudited. Open it and scan, the way the surface-tab
// case above does for the homepage terminals.
test.describe("/verify provider picker (open state)", () => {
  test("no violations with the provider popover open", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/verify");
    await page.getByRole("heading", { level: 1 }).waitFor();

    await page.getByLabel("Provider").click();
    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();
    // Non-vacuous: a popover that rendered no options would otherwise pass this scan trivially.
    expect(await listbox.getByRole("option").count()).toBeGreaterThan(50);

    await expectClean(page);
  });

  test("the picker is keyboard-operable and filters", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/verify");
    await page.getByRole("heading", { level: 1 }).waitFor();

    await page.getByLabel("Provider").click();
    await page.getByRole("combobox", { name: /search .* providers/i }).fill("shopify");
    await page
      .getByRole("option", { name: /shopify/i })
      .first()
      .click();
    // The signature-header label is recipe-driven, so it proves the selection actually landed.
    await expect(page.getByText(/x-shopify-hmac-sha256/i)).toBeVisible();
  });
});
