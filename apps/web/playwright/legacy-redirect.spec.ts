import { expect, test } from "@playwright/test";

import { signIn, world } from "./support";

// Old dashboard bookmarks after the URL move (ADR-0117 hard cutover). The unit tests prove the redirect
// LOGIC; only this proves Next actually ROUTES a deleted top-level path to the catch-all (rather than 404ing
// before it), and that the status is a 307 to the caller's default org with the path + query intact.

test("a known legacy path forwards to the signed-in user's default org, 307, path+query intact", async ({
  page,
}) => {
  const { users, orgs } = world();
  await signIn(page, users.robin.id, orgs.beta.id); // Robin's acting org is Beta
  const req = page.context().request;

  const res = await req.get("/deliveries?status=failed", { maxRedirects: 0 });

  expect(res.status()).toBe(307);
  expect(res.headers()["location"]).toBe(`/org/${orgs.beta.slug}/deliveries?status=failed`);
});

test("a deep legacy sub-path keeps every segment", async ({ page }) => {
  const { users, orgs } = world();
  await signIn(page, users.robin.id, orgs.beta.id);
  const req = page.context().request;

  const res = await req.get("/endpoints/ep_1/events/ev_2", { maxRedirects: 0 });

  expect(res.status()).toBe(307);
  expect(res.headers()["location"]).toBe(`/org/${orgs.beta.slug}/endpoints/ep_1/events/ev_2`);
});

test("an UNKNOWN path stays a clean 404 — a typo is not a moved bookmark", async ({ page }) => {
  const { users, orgs } = world();
  await signIn(page, users.robin.id, orgs.beta.id);
  const req = page.context().request;

  const res = await req.get("/totally-not-a-page", { maxRedirects: 0 });

  expect(res.status()).toBe(404);
  expect(res.headers()["location"]).toBeUndefined(); // not redirected one level deeper
});

test("an unauthenticated legacy path goes to sign-in, not a redirect loop", async ({ request }) => {
  const res = await request.get("/billing", { maxRedirects: 0 });

  expect(res.status()).toBe(307);
  expect(res.headers()["location"]).toContain("/login");
});
