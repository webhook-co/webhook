import { expect, test } from "@playwright/test";

import { createClient, withTenant } from "@webhook-co/db";

import { signIn, world } from "./support";

// Membership is checked PER REQUEST, or it is not checked at all.
//
// The session cookie is stateless: a signed token with a 7-day TTL and no server-side revocation store. So
// the org it names is a claim made at mint time, and it keeps being made long after it stops being true. The
// only thing that can make it honest is re-reading membership on every request — which is what
// `requireOrgAccess` exists to do.
//
// These two specs are the regression lock for that. They are written from the attacker's side: not "does the
// gate get called" (a unit test can be fooled into believing that by a mock) but "does the data come out".

const SECRET_ENDPOINT = "Alpha payroll hook";
const BETA_ENDPOINT = "Beta ops hook";

test.describe.configure({ mode: "serial" });

test("seed: Alpha has an endpoint", async ({ page }) => {
  const { users, orgs } = world();
  await signIn(page, users.dana.id, orgs.alpha.id);

  await page.goto(`/org/${orgs.alpha.slug}/endpoints`);
  await page.getByRole("button", { name: "Create endpoint" }).click();
  await page.getByLabel("Endpoint name").fill(SECRET_ENDPOINT);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: "Done" }).click();

  await expect(page.getByRole("cell", { name: SECRET_ENDPOINT }).first()).toBeVisible();
});

test("a session naming an org you do not belong to discloses nothing", async ({ page }) => {
  const { users, orgs } = world();

  // Robin has NO membership in Alpha. Hand them a session that names it anyway — precisely the shape of a
  // cookie that has outlived the membership that justified it.
  //
  // Driven through the request context rather than `page.goto`, because a working gate REFUSES this, and
  // following that refusal would navigate to the deliberately-dead auth origin.
  const req = page.context().request;
  await req.get(`/dev-session?user=${users.robin.id}&org=${orgs.alpha.id}`, { maxRedirects: 0 });

  const res = await req.get(`/org/${orgs.alpha.slug}/endpoints`, { maxRedirects: 0 });

  // The assertion is the DISCLOSURE, not the status code — the bytes are what leak. A gate that redirects is
  // fine, and a gate that somehow rendered an empty list would be fine too; a response carrying Alpha's
  // endpoint name to a non-member is the bug, however it is dressed.
  expect(res.status()).not.toBe(200);
  expect(await res.text()).not.toContain(SECRET_ENDPOINT);
});

test("a removed member's live session stops reading the org immediately", async ({ page }) => {
  const { users, orgs, appConnectionString } = world();

  // Sam is a member of Beta and holds a valid session for it. Give Beta a secret of its own, so that after the
  // removal there is something CONCRETE to prove did not leak — a bare `status !== 200` would pass on a 500,
  // on a crash, on an empty render, on anything at all that isn't a success, which is not the claim.
  await signIn(page, users.sam.id, orgs.beta.id);
  await page.goto(`/org/${orgs.beta.slug}/endpoints`);
  await page.getByRole("button", { name: "Create endpoint" }).click();
  await page.getByLabel("Endpoint name").fill(BETA_ENDPOINT);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("cell", { name: BETA_ENDPOINT }).first()).toBeVisible();

  // Now remove him. Nothing touches his cookie — it is stateless, cannot be revoked, and stays
  // cryptographically valid for the rest of its 7-day life. The membership row is the only thing that
  // changed, so re-reading the membership row is the only thing that can stop him.
  const db = createClient(appConnectionString, { max: 1 });
  try {
    await withTenant(
      db,
      orgs.beta.id,
      (tx) =>
        tx`delete from memberships where org_id = ${orgs.beta.id} and user_id = ${users.sam.id}`,
    );
  } finally {
    await db.end({ timeout: 5 }).catch(() => {});
  }

  // Same cookie, same browser, next request. He must not be reading Beta any more — and specifically, the
  // endpoint he could see one request ago must not be in these bytes.
  const res = await page
    .context()
    .request.get(`/org/${orgs.beta.slug}/endpoints`, { maxRedirects: 0 });
  expect(res.status()).not.toBe(200);
  expect(await res.text()).not.toContain(BETA_ENDPOINT);
});
