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

// The five legal pages. Until now they had jsdom-only axe coverage — which cannot see layout, and
// therefore cannot see color contrast (1.4.3) or target size (2.5.8). So the pages a customer's
// lawyer actually reads were the least verified on the site. They are also where the section anchors
// live, so this is the only layer that can prove the affordance works.
const LEGAL_PAGES = ["/terms", "/privacy", "/dpa", "/acceptable-use", "/sub-processors"];

test.describe("legal page accessibility (real browser)", () => {
  for (const path of LEGAL_PAGES) {
    test(`${path} has no violations`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).waitFor();
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
});

test.describe("pricing page accessibility (real browser)", () => {
  test("no violations, including the FAQ opened", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/pricing");
    await expectClean(page);

    // A native <details> changes the a11y tree when it opens; scan the expanded state too.
    await page.getByText("What counts as an event?").click();
    await expectClean(page);
  });

  // The founder's actual complaint: this line wrapped to two lines in the Free card.
  test("the Free plan's overage line sets on one line", async ({ page }) => {
    await page.goto("/pricing");
    const line = page.getByText("No overage. Capture pauses.", { exact: true });
    await expect(line).toBeVisible();

    const box = await line.boundingBox();
    // One line at the tier-card font size. Two lines would be ~44px+.
    expect(box!.height).toBeLessThan(30);
  });
});

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
