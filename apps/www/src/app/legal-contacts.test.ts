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

/**
 * Does the PARAGRAPH that makes `promise` actually link to `address`?
 *
 * A character-window check is not enough, and I proved it: with a 900-char window, retargeting the refund
 * paragraph's address away from support@ still PASSED, because the Terms publish support@ again a little
 * further down for general support. The test has to be anchored to the paragraph making the promise —
 * otherwise it proves only that the address exists somewhere on the page, which is not the guarantee we want.
 */
function promiseRoutesTo(src: string, promise: string, address: string): boolean {
  // Split on JSX block-level boundaries; the promise and its mailto: must live in the SAME block. Both <p>
  // AND <blockquote> count — the Privacy summary makes a real "questions or requests" promise inside a
  // <blockquote>, and binding only <p> would leave that channel unguarded (a retarget there would slip by).
  const blocks = src.split(/<p>|<blockquote>/).map((b) => b.split(/<\/p>|<\/blockquote>/)[0]);
  const block = blocks.find((b) =>
    b.replace(/\s+/g, " ").toLowerCase().includes(promise.toLowerCase()),
  );
  if (!block) return false; // the promise itself vanished — also a failure
  return block.includes(`mailto:${address}`);
}

describe("each channel the legal docs promise actually exists", () => {
  const read = (page: string) =>
    readFileSync(join(process.cwd(), "src/app", page, "page.tsx"), "utf8");

  it("the AUP publishes BOTH an abuse channel and a vulnerability-disclosure channel", () => {
    // These are the two channels an outsider needs. Losing either silently is how a security report
    // ends up in nobody's inbox.
    const aup = read("acceptable-use");
    expect(promiseRoutesTo(aup, "in breach of this policy", "abuse@webhook.co")).toBe(true);
    expect(promiseRoutesTo(aup, "security vulnerability", "security@webhook.co")).toBe(true);
  });

  it("the Privacy Policy routes data-subject requests to privacy@, not a personal inbox", () => {
    // The DSAR sentence itself must carry the address — that is the channel a regulator will look for.
    expect(promiseRoutesTo(read("privacy"), "to exercise any of these", "privacy@webhook.co")).toBe(
      true,
    );
  });

  it("the Privacy summary's 'questions or requests' promise also routes to privacy@", () => {
    // This one lives in a <blockquote>, not a <p> — the first channel most people read. Binding it proves
    // the helper now covers block-quotes, so a retarget of the summary address can't slip past the tests.
    expect(promiseRoutesTo(read("privacy"), "Questions or", "privacy@webhook.co")).toBe(true);
  });

  it("the DPA binds each legal@ promise to the PARAGRAPH that makes it, not merely the page", () => {
    // toContain("legal@") is too weak: the DPA publishes legal@ in THREE distinct paragraphs
    // (countersignature, the sub-processor-change notice, and the closing questions line). Any one could
    // be retargeted or deleted and a page-level toContain would still pass on the other two. Bind each
    // promise to the address it must keep pointing at.
    const dpa = read("dpa");
    expect(promiseRoutesTo(dpa, "requires a countersignature", "legal@webhook.co")).toBe(true);
    expect(promiseRoutesTo(dpa, "To receive that notice", "legal@webhook.co")).toBe(true);
    expect(promiseRoutesTo(dpa, "countersignature request", "legal@webhook.co")).toBe(true);
  });

  it("the sub-processors page binds the change-notice promise to legal@", () => {
    expect(promiseRoutesTo(read("sub-processors"), "To get that notice", "legal@webhook.co")).toBe(
      true,
    );
  });

  it("the Terms bind the refund-review PROMISE to the support channel, not merely mention it", () => {
    // §6 promises "email us and we'll review it case by case". Asserting that support@ appears SOMEWHERE on
    // the page is too weak: the Terms also publish support@ for general support, so the refund paragraph
    // could be retargeted or deleted and the test would still pass. Bind the address to the promise.
    expect(promiseRoutesTo(read("terms"), "case by case", "support@webhook.co")).toBe(true);
  });

  it("the Terms bind the compromised-credential report to the security channel", () => {
    // Same reasoning: §3 tells you to report a compromised key. That sentence must keep pointing at
    // security@, not just leave a security@ somewhere else on the page.
    expect(promiseRoutesTo(read("terms"), "compromised", "security@webhook.co")).toBe(true);
  });
});
