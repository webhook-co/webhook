import { expect, test } from "@playwright/test";

import { signIn, world } from "./support";

// The auth gate, seen from a browser. The unit tests for these pages MOCK the gate, so they cannot tell you
// whether it is actually wired into the rendered route — only this can.

test("an unauthenticated request to a gated page is redirected to sign-in, never served", async ({
  request,
}) => {
  const { orgs } = world();
  const res = await request.get(`/org/${orgs.alpha.slug}/endpoints`, { maxRedirects: 0 });

  expect(res.status()).toBe(307);
  expect(res.headers()["location"]).toContain("/login");
});

test("a foreign org's slug 404s — it does NOT bounce you to sign-in", async ({ page }) => {
  const { users, orgs } = world();

  // Robin belongs to Beta only. They ask for Alpha's URL directly. Both reasons for the 404 matter:
  //
  //   1. A sign-in redirect would INFINITE-LOOP. auth. signs them straight back in, they land on the same
  //      bookmarked URL, and it bounces them out again. Forever. Before the URL move the gate could get away
  //      with `redirect(LOGIN_URL)` because the org came from the COOKIE, and re-authenticating changed it.
  //      Now the org is in the URL, and re-authenticating changes nothing.
  //   2. A 403 would be an enumeration oracle — it would confirm the org EXISTS. There is nothing to confirm
  //      here: the resolver looks only inside Robin's own directory.
  const req = page.context().request;
  await req.get(`/dev-session?user=${users.robin.id}&org=${orgs.beta.id}`, { maxRedirects: 0 });

  const res = await req.get(`/org/${orgs.alpha.slug}/endpoints`, { maxRedirects: 0 });

  expect(res.status()).toBe(404);
  expect(res.headers()["location"]).toBeUndefined(); // not a redirect at all
});

test("a real org you cannot see and a slug nobody registered are INDISTINGUISHABLE", async ({
  page,
}) => {
  const { users, orgs } = world();
  await signIn(page, users.robin.id, orgs.beta.id);
  const req = page.context().request;

  const real = await req.get(`/org/${orgs.alpha.slug}/endpoints`, { maxRedirects: 0 });
  const fake = await req.get("/org/no-such-org-anywhere/endpoints", { maxRedirects: 0 });

  // This is the enumeration property, stated as a test: you cannot learn anything by asking. Not "we return
  // 404 for both" as an implementation detail — the two responses are the SAME, so there is no signal.
  expect(real.status()).toBe(404);
  expect(fake.status()).toBe(real.status());
});
