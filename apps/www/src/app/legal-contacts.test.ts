import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Every address we publish in a legal document is a promise that someone will read what's sent to it. An
// abuse report, a vulnerability disclosure, or a refund request that bounces is worse than never having
// offered the channel — the customer thinks they've reached us, and they haven't.
//
// So: legal pages may only publish an address from this allowlist, and EVERY address on the allowlist must
// have a routing rule on the webhook.co zone. Founder is configuring these (2026-07-11). If you add an address
// to a legal page, add it here AND configure the routing — a legal doc is not the place to discover a typo.

const LEGAL_PAGES = ["terms", "privacy", "dpa", "acceptable-use", "sub-processors"];

/**
 * The role addresses the legal documents publish. Each MUST have a routing rule on the zone.
 *   privacy@  — data-subject requests, privacy questions (Privacy Policy)
 *   legal@    — the contract: DPA, countersignature, sub-processor change notices, formal notices
 *   security@ — vulnerability disclosure, compromised-credential reports
 *   abuse@    — abuse reports (AUP)
 *   support@  — billing questions, and the "we'll review it case by case" refund channel
 */
const ROUTES = new Set([
  "privacy@webhook.co",
  "legal@webhook.co",
  "security@webhook.co",
  "abuse@webhook.co",
  "support@webhook.co",
]);

describe("legal pages only publish email addresses that actually route", () => {
  it.each(LEGAL_PAGES)("%s publishes no unrouted address", (page) => {
    const src = readFileSync(join(process.cwd(), "src/app", page, "page.tsx"), "utf8");
    const addresses = [...src.matchAll(/([a-z0-9._-]+@webhook\.co)/gi)].map((m) => m[1]);
    const unrouted = [...new Set(addresses)].filter((a) => !ROUTES.has(a.toLowerCase()));
    expect(unrouted).toEqual([]);
  });
});

describe("each channel the legal docs promise actually exists", () => {
  const read = (page: string) =>
    readFileSync(join(process.cwd(), "src/app", page, "page.tsx"), "utf8");

  it("the AUP publishes BOTH an abuse channel and a vulnerability-disclosure channel", () => {
    // These are the two channels an outsider needs. Losing either silently is how a security report
    // ends up in nobody's inbox.
    const aup = read("acceptable-use");
    expect(aup).toContain("abuse@webhook.co");
    expect(aup).toContain("security@webhook.co");
  });

  it("the Privacy Policy routes data-subject requests to privacy@, not a personal inbox", () => {
    const privacy = read("privacy");
    expect(privacy).toContain("privacy@webhook.co");
  });

  it("the DPA routes the contract + sub-processor notices to legal@", () => {
    expect(read("dpa")).toContain("legal@webhook.co");
    expect(read("sub-processors")).toContain("legal@webhook.co");
  });

  it("the Terms route the refund-review promise to a support channel", () => {
    // §6 promises "email us and we'll review it case by case" — that promise needs a reachable address.
    expect(read("terms")).toContain("support@webhook.co");
  });
});
