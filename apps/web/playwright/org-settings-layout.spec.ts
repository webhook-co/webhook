import { expect, test } from "@playwright/test";

import { signIn, world } from "./support";

// The two-column Organization card, asserted in a browser that actually computes layout.
//
// The unit suite is jsdom: it applies no stylesheet and computes no geometry, so `sm:flex-row`, `shrink-0`
// and `min-w-0` are to it just characters in a className string. It would pass with the columns overlapping,
// collapsed, or refusing to stack — which is precisely the behaviour this card was restructured to produce.
// Class-presence assertions prove nothing about CSS; only real geometry does.
//
// This does NOT discharge the human-UI check (spacing, proportion, whether it reads as one thing). It pins
// the invariants that can be stated numerically, so a regression fails CI instead of a founder's eyeball.

/** Left edge → right edge. */
const right = (b: { x: number; width: number }) => b.x + b.width;
/** Top edge → bottom edge. */
const bottom = (b: { y: number; height: number }) => b.y + b.height;

async function boxes(page: import("@playwright/test").Page) {
  // The COLUMN, not the button inside it: the column holds the tile above the buttons, so the button alone
  // sits lower than the Name field even when the two columns are correctly side by side.
  const logo = await page.getByTestId("org-logo-column").boundingBox();
  const name = await page.getByLabel("Name").boundingBox();
  expect(logo, "logo column must render").not.toBeNull();
  expect(name, "name field must render").not.toBeNull();
  return { logo: logo!, name: name! };
}

test("the logo sits BESIDE the fields on a wide viewport, without squeezing them", async ({
  page,
}) => {
  const { users, orgs } = world();
  await signIn(page, users.dana.id, orgs.alpha.id);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/org/${orgs.alpha.slug}/settings`);
  await expect(page.getByLabel("Name")).toBeVisible();

  const { logo, name } = await boxes(page);

  // Side by side: the logo column ends before the fields begin, and they share vertical space.
  expect(right(logo)).toBeLessThanOrEqual(name.x);
  expect(logo.y).toBeLessThan(bottom(name));
  expect(name.y).toBeLessThan(bottom(logo));

  // The whole point of `shrink-0` + `min-w-0`: a 72px tile must not squeeze the fields into a sliver.
  expect(name.width).toBeGreaterThan(300);
});

test("the columns STACK on a narrow viewport — the logo above the fields, never a sliver", async ({
  page,
}) => {
  const { users, orgs } = world();
  await signIn(page, users.dana.id, orgs.alpha.id);
  await page.setViewportSize({ width: 390, height: 844 }); // a phone, below the `sm` breakpoint
  await page.goto(`/org/${orgs.alpha.slug}/settings`);
  await expect(page.getByLabel("Name")).toBeVisible();

  const { logo, name } = await boxes(page);

  // Stacked: the logo column is entirely above the fields, not beside them.
  expect(bottom(logo)).toBeLessThanOrEqual(name.y);
  // And the fields now use the width they just got back.
  expect(name.width).toBeGreaterThan(240);
});

test("the page never scrolls sideways at a phone width", async ({ page }) => {
  // A general responsive guard, and no more than that. It does NOT catch a failure to stack: the fields
  // column carries `min-w-0`, so a `shrink-0` tile refusing to stack squeezes the fields rather than pushing
  // the document wider — the two tests above are what cover that. What this does catch is the class of
  // regression min-w-0 cannot absorb: a fixed-width child, an unbreakable string, a stray negative margin.
  const { users, orgs } = world();
  await signIn(page, users.dana.id, orgs.alpha.id);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/org/${orgs.alpha.slug}/settings`);
  await expect(page.getByLabel("Name")).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
