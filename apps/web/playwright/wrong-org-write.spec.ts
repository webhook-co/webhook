import { expect, test } from "@playwright/test";

import { signIn, world } from "./support";

// 🔴 THE BUG THIS ENTIRE LANE EXISTS TO DELETE.
//
// The org used to come from the session cookie, and there is exactly ONE cookie per browser. So:
//
//     Tab A is open on Org Alpha.
//     In tab B you switch to Org Beta  →  the cookie now says Beta.
//     Back in tab A — still rendering Alpha, still showing Alpha's endpoints — you click "Create endpoint".
//     The action reads the cookie, sees BETA, and creates the endpoint in the WRONG ORGANIZATION. Silently.
//
// RLS does not save you: the user IS a member of Beta, so the write is perfectly authorized — just aimed at
// the wrong place. The same held for minting an API key, sending an invite, and changing someone's role.
//
// Now the org is in the URL. Tab A's URL says `/org/alpha-e2e/…`, its actions are bound to that slug, and the
// gate re-resolves it per request. There is no cookie left to disagree with — the org a page renders and the
// org its actions mutate are the same string, and it is in the address bar.
//
// Dana is a member of BOTH orgs, which is what makes this reachable at all: the write must be authorized to
// be dangerous. A test where the write is refused would prove nothing about the bug.
test("a second tab switching orgs cannot retarget the first tab's writes", async ({ browser }) => {
  const { users, orgs } = world();
  const context = await browser.newContext(); // ONE browser context = ONE cookie jar, which is the whole point
  const tabA = await context.newPage();
  const tabB = await context.newPage();

  try {
    // Tab A: Dana, working in ALPHA.
    await signIn(tabA, users.dana.id, orgs.alpha.id);
    await tabA.goto(`/org/${orgs.alpha.slug}/endpoints`);
    await expect(tabA.getByRole("heading", { name: "Endpoints" })).toBeVisible();

    // Tab B: the same Dana switches to BETA. Under the old design this silently re-minted the shared cookie
    // onto Beta — and tab A, which never reloaded, had no idea.
    await tabB.goto(`/org/${orgs.beta.slug}/dashboard`);
    await expect(tabB).toHaveURL(new RegExp(`/org/${orgs.beta.slug}/dashboard`));

    // Tab A, unaware, creates an endpoint. It is still on Alpha's URL.
    const name = "Created from the Alpha tab";
    await tabA.getByRole("button", { name: "Create endpoint" }).click();
    await tabA.getByLabel("Endpoint name").fill(name);
    await tabA.getByRole("button", { name: "Create", exact: true }).click();
    await tabA.getByRole("button", { name: "Done" }).click();

    // It must land in ALPHA — the org whose page the user was actually looking at.
    await tabA.reload();
    await expect(tabA.getByRole("cell", { name }).first()).toBeVisible();

    // …and it must NOT be in Beta. This is the assertion that used to fail.
    await tabB.goto(`/org/${orgs.beta.slug}/endpoints`);
    await expect(tabB.getByRole("heading", { name: "Endpoints" })).toBeVisible();
    await expect(tabB.getByRole("cell", { name })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
