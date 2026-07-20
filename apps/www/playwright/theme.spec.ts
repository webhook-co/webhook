import { expect, test } from "@playwright/test";

/**
 * The theme toggle, in a real browser — because the two things that can actually go wrong here are
 * invisible to jsdom.
 *
 * 1. THE FLASH. The site is a static export: there is no server to read a cookie, so the theme is
 *    applied by an inline, render-blocking script that stamps `data-theme` on <html> BEFORE first
 *    paint. If it were deferred (or moved into a React effect) a dark-mode reader would get a white
 *    flash on every single navigation. That is a real-browser property; a component test can't see it.
 * 2. PERSISTENCE. The choice must survive a navigation, or the toggle is a gimmick.
 */

test.describe("theme toggle", () => {
  /**
   * Wait for hydration to SETTLE before asserting. The bug this exists for: the pre-paint script
   * stamps `data-theme` on <html>, React then hydrates that element and can drop an attribute it never
   * rendered — so the page silently falls back to light while the toggle still reports dark. Asserting
   * too early passes against that, because the attribute is briefly there. The toggle only becomes
   * interactive after hydration, so waiting for it is waiting for the thing that breaks it.
   */
  async function afterHydration(page: import("@playwright/test").Page) {
    await page.getByRole("button", { name: /switch to (light|dark) theme/i }).waitFor();
    await page.waitForTimeout(250);
  }

  test("defaults to dark on a first visit, regardless of the OS preference", async ({ page }) => {
    // OS says light — the default must still be dark (brand-first, OS-independent).
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    await afterHydration(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    // OS says dark — still dark. Same fixed default either way.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await afterHydration(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("flips to light, and the choice survives a navigation", async ({ page }) => {
    await page.goto("/");
    await afterHydration(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.getByRole("button", { name: /switch to light theme/i }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    // The whole point: it must still be light on the next page, applied before paint.
    await page.goto("/pricing");
    await afterHydration(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.getByRole("button", { name: /switch to dark theme/i })).toBeVisible();
  });

  test("a stored choice OUTRANKS the dark default", async ({ page }) => {
    await page.goto("/");
    await afterHydration(page);
    // Default dark → switch to light and persist the choice.
    await page.getByRole("button", { name: /switch to light theme/i }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    // Reload: the stored 'light' must beat the dark default, or the toggle doesn't hold.
    await page.reload();
    await afterHydration(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });

  // ⚠️ WHAT THIS DOES AND DOESN'T PROVE. It catches the theme never being applied at all. It does NOT
  // catch the script being moved somewhere too late to beat first paint — mutation-checked: moving it
  // to the end of <body> still passes, because `readyState: interactive` fires AFTER body scripts run.
  // The POSITION of the script (in <head>, ahead of the stylesheets) is what actually decides whether
  // a dark reader sees a white flash, and that is guarded structurally in scripts/check-export.mjs
  // against the built HTML. Don't mistake this for the FOUC guard.
  test("the theme is applied by document-interactive (it is never left unset)", async ({
    page,
  }) => {
    // OS says light — proves the pre-paint default is dark independent of the OS, and that it is
    // stamped early (not by a later React effect).
    await page.emulateMedia({ colorScheme: "light" });

    // Read <html data-theme> at the earliest moment scripts can observe the document. If the theme
    // were applied by a React effect (or a deferred script) this would still be unset here, and the
    // reader would see a light page for a frame.
    await page.addInitScript(() => {
      document.addEventListener("readystatechange", () => {
        if (document.readyState === "interactive") {
          (window as unknown as { __themeAtInteractive?: string | null }).__themeAtInteractive =
            document.documentElement.getAttribute("data-theme");
        }
      });
    });
    await page.goto("/");

    const early = await page.evaluate(
      () => (window as unknown as { __themeAtInteractive?: string | null }).__themeAtInteractive,
    );
    expect(early, "data-theme must be stamped before the document is interactive").toBe("dark");
  });
});
