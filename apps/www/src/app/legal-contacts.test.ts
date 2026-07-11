import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Every address we publish in a legal document is a promise that someone will read what's sent to it. An
// abuse report, a vulnerability disclosure, or a refund request that bounces is worse than never having
// offered the channel — the customer thinks they've reached us, and they haven't.
//
// So: legal pages may only publish an address we have confirmed routes. Role aliases (support@, abuse@,
// legal@, security@) are NOT yet configured on the zone. When they are, add them to ROUTES and use them.

const LEGAL_PAGES = ["terms", "privacy", "dpa", "acceptable-use", "sub-processors"];

/** Addresses confirmed to reach a human. Add to this ONLY after verifying the routing rule exists. */
const ROUTES = new Set(["sourabh@webhook.co"]);

describe("legal pages only publish email addresses that actually route", () => {
  it.each(LEGAL_PAGES)("%s publishes no unrouted address", (page) => {
    const src = readFileSync(join(process.cwd(), "src/app", page, "page.tsx"), "utf8");
    const addresses = [...src.matchAll(/([a-z0-9._-]+@webhook\.co)/gi)].map((m) => m[1]);
    const unrouted = [...new Set(addresses)].filter((a) => !ROUTES.has(a.toLowerCase()));
    expect(unrouted).toEqual([]);
  });
});
