import { expect, test } from "@playwright/test";

/**
 * Copy defects that only exist in the SERVER-RENDERED markup, checked against the built export.
 *
 * These cannot be caught in jsdom. React Testing Library renders `See all {n} providers` with its
 * whitespace intact, so a component test passes whether or not the bug is present (verified by
 * mutation). But JSX drops the whitespace around an interpolated expression when the neighbouring
 * text sits on its own line, and the site shipped "See all 142providers" — spotted by a human, not by
 * 300-odd green tests. This spec reads what actually goes on the wire.
 */
test.describe("rendered copy", () => {
  test("the provider link keeps its spaces around the interpolated count", async ({ page }) => {
    await page.goto("/");
    const link = page.getByRole("link", { name: /see all \d+ providers/i });
    await expect(link).toBeVisible();

    const text = (await link.textContent())?.trim() ?? "";
    expect(text).toMatch(/See all \d+ providers/);
    // The exact shape of the defect: a digit butting straight against the next word.
    expect(text).not.toMatch(/\d+providers/);
  });

  test("no word anywhere on the homepage is fused to a number by a lost JSX space", async ({
    page,
  }) => {
    await page.goto("/");
    // The same class of bug, anywhere else it might land: `{count}` followed by text on a new line.
    const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    expect(body).not.toMatch(/\d(providers|events|endpoints|requests|surfaces)\b/i);
  });

  test("the provider link lands on the registry section, not the top of the page", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /see all \d+ providers/i }).click();
    await page.waitForURL(/\/product\/verification#providers$/);
    // The heading it points at must exist and be in view — a fragment that resolves to nothing is a
    // scroll-to-nowhere, which looks exactly like a broken page.
    await expect(page.locator("#providers")).toBeInViewport();
  });
});
