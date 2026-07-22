import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The footer's status badge is an iframe to status.webhook.co, and the footer renders on EVERY page.
 *
 * `public/_headers` sets `default-src 'self'`, and `frame-src` falls back to `default-src` when it is
 * absent — so a CSP that simply doesn't mention frames blocks the badge site-wide with Chrome's
 * "This content is blocked" panel. That is exactly how it shipped broken: the policy looked
 * untouched, so nothing suggested it needed changing.
 */
const HEADERS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "_headers"),
  "utf8",
);

/** Every `Content-Security-Policy:` line in the file, whichever path rule it belongs to. */
const policies = HEADERS.split("\n")
  .map((l) => l.trim())
  .filter((l) => l.startsWith("Content-Security-Policy:"));

describe("public/_headers CSP", () => {
  it("declares at least the site-wide and /play policies", () => {
    // Floor: if parsing breaks, the assertions below would pass over an empty list.
    expect(policies.length).toBeGreaterThanOrEqual(2);
  });

  // The load-bearing one. Not "contains status.webhook.co somewhere" — it must be reachable as a
  // FRAME, which is a different directive from connect-src or img-src.
  it("allows the status badge as a frame in every policy", () => {
    for (const p of policies) {
      const frameSrc = /frame-src ([^;]+)/.exec(p)?.[1] ?? "";
      expect(frameSrc, p.slice(0, 60)).toContain("https://status.webhook.co");
    }
  });

  it("still forbids the site itself from being framed", () => {
    // frame-src is about what WE may embed; frame-ancestors is about who may embed US. Widening the
    // first must never quietly widen the second.
    for (const p of policies) expect(p).toContain("frame-ancestors 'none'");
  });

  it("keeps the default restrictive", () => {
    for (const p of policies) expect(p).toContain("default-src 'self'");
  });
});
