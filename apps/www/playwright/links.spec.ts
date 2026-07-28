import { expect, test } from "@playwright/test";

import { LINKS, SALES } from "../src/lib/links";

/**
 * Every outbound destination the marketing site advertises, actually requested.
 *
 * The unit test in `src/lib/links.test.ts` compares strings against the same constants it is
 * testing — it is tautological for slug correctness. Nothing there can tell a live docs page from a
 * renamed one, and a renamed docs slug is a 404 in the nav, the footer and the hero simultaneously.
 * This is the only check that would notice.
 *
 * Transient network blips are absorbed by RETRIES, never by skipping. An unreachable destination is
 * itself worth knowing about, and swallowing it would be exactly the "quietly green" failure mode
 * this spec exists to prevent (skipping is also a non-negotiable in AGENTS.md). What it will not
 * tolerate is a 404 or a 410 — those mean the destination is genuinely gone.
 */
/**
 * Hosts that answer an automated request with a synthetic block code, never a real HTTP status.
 *
 * LinkedIn returns `999` to any non-browser client (its anti-scraping wall). That is neither a 404
 * nor a real 5xx — it's "you're a bot", returned to EVERY request this spec could ever make. So a
 * LinkedIn URL can only ever produce a false failure here; it can never catch the renamed-slug 404
 * this spec exists to find. That makes it categorically different from a reachable destination we'd
 * be wrong to skip: its liveness is unobservable from an API client by design. Its FORMAT is still
 * pinned by `src/lib/links.test.ts`, so a typo'd LinkedIn URL is still caught — just not here.
 */
const BOT_WALLED_HOSTS = new Set(["www.linkedin.com"]);

const external = [...Object.values(LINKS), ...Object.values(LINKS.concepts), SALES].filter(
  (href): href is string =>
    typeof href === "string" &&
    href.startsWith("https://") &&
    !BOT_WALLED_HOSTS.has(new URL(href).hostname),
);

const destinations = [...new Set(external)].sort();

test.describe("outbound links resolve", () => {
  // A cold Mintlify edge or a rate-limited GitHub is a blip, not a broken link — absorb it by
  // retrying rather than by skipping, so a genuinely dead destination still fails.
  test.describe.configure({ retries: 2 });

  test("we advertise at least the docs, app, auth and github destinations", () => {
    // A guard on the guard: if `LINKS` were refactored into a shape this spec can't flatten, the
    // loop below would silently check nothing and still pass.
    expect(destinations.length).toBeGreaterThanOrEqual(10);
  });

  for (const url of destinations) {
    test(`${url} is not dead`, async ({ request }) => {
      const response = await request.get(url, { timeout: 20_000, maxRedirects: 5 });
      const status = response.status();

      // 404/410 = the page is genuinely gone — the failure this exists to catch. A 429 from GitHub
      // or a 3xx we followed is not evidence of a broken link.
      expect(status, `${url} returned ${status} — the destination no longer exists`).not.toBe(404);
      expect(status, `${url} returned ${status} — the destination is gone`).not.toBe(410);
      expect(status, `${url} returned ${status}`).toBeLessThan(500);
    });
  }
});

/**
 * The same destinations again, but WITHOUT following redirects — and only the ones we own.
 *
 * `maxRedirects: 5` above makes a redirect hop invisible: `https://docs.webhook.co` 308s to
 * `/introduction` and reads as a clean 200. That blind spot let 223 internal links accumulate
 * against a redirect (186 to the docs root, 37 to `/guides`), which is what Ahrefs Site Audit filed
 * as "Page has links to redirect: 184". A hop costs a round trip for every visitor and bleeds link
 * equity on every crawl, and unlike a third-party redirect we can just fix ours by linking to where
 * the redirect already lands.
 *
 * Scoped to webhook.co hosts on purpose: a third party is free to reorganise its own URLs, and
 * failing our CI on GitHub's redirect choices would be a guard nobody could keep green.
 */
const OWN_HOSTS = /(^|\.)webhook\.co$/;
/**
 * status.webhook.co sits behind the status vendor's Bunny Shield, which answers every non-browser
 * request with a 403 JS challenge — it can never return a 200 here, so it can only produce a false
 * failure. Its liveness is unobservable from an API client, exactly like the LinkedIn case above.
 */
const CHALLENGE_WALLED = new Set(["status.webhook.co"]);
/**
 * Hosts whose response depends on the visitor's SESSION, so there is no session-independent status
 * to assert. `app.webhook.co` 307s a signed-out visitor to `auth.webhook.co/login` and serves the
 * org overview to a signed-in one — that is the product behaviour `LINKS.startFree` documents, not
 * a link we could "fix" by pointing deeper (www has no idea which org a visitor belongs to, or
 * whether they have one). It also costs nothing in crawl equity: app.webhook.co serves
 * `robots.txt: Disallow: /`, so no crawler follows the hop in the first place.
 *
 * The exemption is keyed on WHY — session-dependent — not on the URL, so a future www link to a
 * genuinely static app path is not silently waved through with it.
 */
const SESSION_DEPENDENT = new Set(["app.webhook.co"]);

const ownDestinations = destinations.filter((u) => {
  const { hostname } = new URL(u);
  return (
    OWN_HOSTS.test(hostname) && !CHALLENGE_WALLED.has(hostname) && !SESSION_DEPENDENT.has(hostname)
  );
});

test.describe("our own outbound links land directly, with no redirect hop", () => {
  test.describe.configure({ retries: 2 });

  test("there are own-host destinations to check", () => {
    // A guard on the guard: a filter that matched nothing would loop zero times and still pass.
    expect(ownDestinations.length).toBeGreaterThanOrEqual(5);
  });

  for (const url of ownDestinations) {
    test(`${url} answers 200 without redirecting`, async ({ request }) => {
      const response = await request.get(url, { timeout: 20_000, maxRedirects: 0 });
      expect(
        response.status(),
        `${url} → ${response.status()} ${response.headers()["location"] ?? ""} — link to the ` +
          `destination directly instead of via the redirect`,
      ).toBe(200);
    });
  }
});
