import { expect, test } from "@playwright/test";

import { world } from "./support";

// The auth gate, seen from a browser. The unit tests for these pages MOCK the gate, so they cannot tell you
// whether it is actually wired into the rendered route — only this can.

test("an unauthenticated request to a gated page is redirected to sign-in, never served", async ({
  request,
}) => {
  const res = await request.get("/endpoints", { maxRedirects: 0 });

  expect(res.status()).toBe(307);
  expect(res.headers()["location"]).toContain("/login");
});

test("a member of one org cannot render another org's dashboard", async ({ page }) => {
  const { users, orgs } = world();

  // Robin belongs to Beta only. Hand them a session that NAMES Alpha — the exact thing a stolen or
  // hand-crafted cookie would do — and the render gate must refuse, because it re-reads membership per
  // request rather than trusting what the session claims.
  //
  // Driven through the request context, not `page.goto`: following the refusal would hit the deliberately
  // dead auth origin. The redirect IS the assertion.
  const req = page.context().request;
  await req.get(`/dev-session?user=${users.robin.id}&org=${orgs.alpha.id}`, { maxRedirects: 0 });

  const res = await req.get("/endpoints", { maxRedirects: 0 });

  expect(res.status()).toBe(307);
  expect(res.headers()["location"]).toContain("/login");
});
