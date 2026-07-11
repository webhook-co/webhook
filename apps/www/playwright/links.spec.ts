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
const external = [...Object.values(LINKS), ...Object.values(LINKS.concepts), SALES].filter(
  (href): href is string => typeof href === "string" && href.startsWith("https://"),
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
