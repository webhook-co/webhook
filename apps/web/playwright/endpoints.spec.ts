import { expect, test } from "@playwright/test";

import { signIn, world } from "./support";

// Serial: the isolation test asserts the ABSENCE of the endpoint the first test creates.
test.describe.configure({ mode: "serial" });

const ALPHA_ENDPOINT = "Alpha billing hook";

/** Create an endpoint through the real dialog, and dismiss the ingest-URL dialog it opens. */
async function createEndpoint(page: import("@playwright/test").Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Create endpoint" }).click();
  await page.getByLabel("Endpoint name").fill(name);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: "Done" }).click();
}

test("creating an endpoint persists it, and it survives a client-side round trip", async ({
  page,
}) => {
  const { users, orgs } = world();
  await signIn(page, users.dana.id, orgs.alpha.id);

  await page.goto("/endpoints");
  await createEndpoint(page, ALPHA_ENDPOINT);

  await expect(page.getByRole("cell", { name: ALPHA_ENDPOINT }).first()).toBeVisible();

  // The `revalidatePath` tripwire, and the reason this suite exists.
  //
  // The assertion above proves nothing on its own: the manager keeps the list in local state and appends the
  // new row itself, so it would pass even if the server-side invalidation were dead. What catches that is
  // leaving and returning through the CLIENT router — the first `goto` populated the Router Cache with the
  // pre-create payload for /endpoints, and only `revalidatePath` evicts it. If that call ever aims at a path
  // that no longer exists (say, after the routes move under /org/{slug}/), the invalidation silently becomes
  // a no-op, the stale payload is served, and the row we just created is missing here.
  //
  // Its unit test cannot see any of this: it asserts `revalidatePath` was called with a string.
  await page.getByRole("link", { name: "Overview" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.getByRole("link", { name: "Endpoints" }).click();
  await expect(page.getByRole("cell", { name: ALPHA_ENDPOINT }).first()).toBeVisible();
});

test("an endpoint is invisible from another org — RLS, under the non-superuser app role", async ({
  page,
}) => {
  const { users, orgs } = world();

  // Dana is a member of BOTH orgs, so this is the honest test of tenancy: the same human, the same browser,
  // a different acting org. Alpha's endpoint must not appear in Beta.
  await signIn(page, users.dana.id, orgs.beta.id);
  await page.goto("/endpoints");

  await expect(page.getByRole("cell", { name: ALPHA_ENDPOINT })).toHaveCount(0);
});
