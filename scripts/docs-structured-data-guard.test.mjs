import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EXPECTED,
  checkSeoOrganization,
  extractSiteUrl,
  extractOrgSameAs,
  checkWwwDrift,
  checkAnalyticsBeacon,
} from "./docs-structured-data-guard.mjs";

/**
 * The docs Organization entity (Mintlify auto-emits it, server-side) must consolidate with www's:
 * same `@id`, non-contradictory name/url/logo/sameAs. Mintlify has no CI, and docs.json is not a
 * workspace, so this guard runs inside the required `pnpm lint`. It PARSES docs.json (JSON), never
 * text-scans it (guard-scripts-must-parse-not-scan), and it carries a fail-closed FLOOR so a missing
 * or empty `seo.organization` fails rather than passing vacuously (a-guards-tests-must-run-the-guard).
 */

/** A valid seo.organization block that byte-matches www's real Organization node. */
const validOrg = () => ({
  id: EXPECTED.id,
  name: EXPECTED.name,
  url: EXPECTED.url,
  logo: EXPECTED.logo,
  sameAs: [...EXPECTED.sameAs],
});
const configWith = (org) => ({ seo: { organization: org } });

// ── checkSeoOrganization: docs.json must match www's Organization ─────────────

test("checkSeoOrganization: a byte-matching seo.organization passes", () => {
  assert.deepEqual(checkSeoOrganization(configWith(validOrg())), []);
});

test("checkSeoOrganization FLOOR: missing seo.organization fails (no vacuous pass)", () => {
  assert.ok(checkSeoOrganization({}).length > 0, "empty config must fail");
  assert.ok(checkSeoOrganization({ seo: {} }).length > 0, "seo without organization must fail");
  assert.ok(checkSeoOrganization(null).length > 0, "null config must fail");
});

test("checkSeoOrganization: the wrong @id fails (this is the whole point)", () => {
  const org = validOrg();
  org.id = "https://docs.webhook.co/#organization"; // the rival entity we're fixing
  const errs = checkSeoOrganization(configWith(org));
  assert.ok(
    errs.some((e) => e.includes("id")),
    `expected an id error, got: ${errs.join("; ")}`,
  );
});

test("checkSeoOrganization: a mismatched url/name/logo each fails", () => {
  for (const field of ["url", "name", "logo"]) {
    const org = validOrg();
    org[field] = "https://example.com/wrong";
    const errs = checkSeoOrganization(configWith(org));
    assert.ok(
      errs.some((e) => e.includes(field)),
      `${field} mismatch must fail`,
    );
  }
});

test("checkSeoOrganization: a fabricated/extra sameAs entry fails (never-fabricate-sameAs)", () => {
  const org = validOrg();
  org.sameAs = [...EXPECTED.sameAs, "https://x.com/webhookco"]; // invented extra profile
  const errs = checkSeoOrganization(configWith(org));
  assert.ok(
    errs.some((e) => e.includes("sameAs")),
    "fabricated sameAs must fail",
  );
});

test("checkSeoOrganization: a missing sameAs (or empty) fails", () => {
  const org = validOrg();
  delete org.sameAs;
  assert.ok(checkSeoOrganization(configWith(org)).some((e) => e.includes("sameAs")));
});

// ── extractSiteUrl: read the one stable const from www's metadata (floored) ───

test("extractSiteUrl: pulls SITE_URL out of the metadata source", () => {
  const src = `export const FOO = 1;\nexport const SITE_URL = "https://www.webhook.co";\n`;
  assert.equal(extractSiteUrl(src), "https://www.webhook.co");
});

test("extractSiteUrl FLOOR: throws when SITE_URL is absent (fail-closed, not vacuous)", () => {
  assert.throws(() => extractSiteUrl("export const NOPE = 2;"));
  assert.throws(() => extractSiteUrl(""));
});

// ── extractOrgSameAs + checkWwwDrift: www's SOURCE must still produce EXPECTED ──

const wwwMetadata = `export const SITE_URL = "https://www.webhook.co";`;
// A minimal stand-in for apps/www's structured-data: the Organization sameAs must equal EXPECTED, and a
// Person node with a DIFFERENT sameAs is included so extractOrgSameAs's scoping is actually exercised.
const wwwStructuredData = `
export const ORG_ID = \`\${SITE_URL}/#organization\`;
export function organizationNode() {
  return { name: "webhook.co", url: SITE_URL, logo: \`\${SITE_URL}/logo.png\`,
    sameAs: [
      "https://github.com/webhook-co",
      "https://www.linkedin.com/company/webhook-co",
      "https://www.crunchbase.com/organization/webhook-co",
    ] };
}
export function personNode() {
  return { name: "Sourabh Choraria",
    sameAs: ["https://www.linkedin.com/in/choraria/", "https://github.com/choraria"] };
}`;

test("extractOrgSameAs: returns the Organization sameAs, scoped away from the Person node", () => {
  assert.deepEqual(extractOrgSameAs(wwwStructuredData), [...EXPECTED.sameAs]);
});

test("extractOrgSameAs FLOOR: throws when organizationNode or its sameAs is absent", () => {
  assert.throws(() => extractOrgSameAs("export const X = 1;"));
  assert.throws(() =>
    extractOrgSameAs('export function organizationNode() { return { name: "x" }; }'),
  );
});

test("checkWwwDrift: passes when www's source still matches EXPECTED", () => {
  assert.deepEqual(
    checkWwwDrift({ metadataSource: wwwMetadata, structuredDataSource: wwwStructuredData }),
    [],
  );
});

test("checkWwwDrift: www ADDING a sameAs entry docs doesn't mirror fails (catches additions, not just removals)", () => {
  // The exact drift #690 introduced: www wired a new off-site profile, making docs a silent subset.
  const src = wwwStructuredData.replace(
    '"https://www.crunchbase.com/organization/webhook-co",',
    '"https://www.crunchbase.com/organization/webhook-co",\n      "https://bsky.app/profile/webhook.co",',
  );
  assert.ok(
    checkWwwDrift({ metadataSource: wwwMetadata, structuredDataSource: src }).some((e) =>
      e.includes("sameAs"),
    ),
    "an added www sameAs entry must fail until docs mirrors it",
  );
});

test("checkWwwDrift: www REMOVING a sameAs entry fails", () => {
  const src = wwwStructuredData.replace(
    '\n      "https://www.crunchbase.com/organization/webhook-co",',
    "",
  );
  assert.ok(
    checkWwwDrift({ metadataSource: wwwMetadata, structuredDataSource: src }).some((e) =>
      e.includes("sameAs"),
    ),
    "a removed www sameAs entry must fail",
  );
});

test("checkWwwDrift: a changed SITE_URL (www drops the www.) fails on the derived @id", () => {
  const errs = checkWwwDrift({
    metadataSource: `export const SITE_URL = "https://webhook.co";`,
    structuredDataSource: wwwStructuredData,
  });
  assert.ok(
    errs.some((e) => e.includes("@id")),
    "a changed SITE_URL must fail the derived @id",
  );
});

test("checkWwwDrift FLOOR: throws when SITE_URL can't be extracted (never vacuous)", () => {
  assert.throws(() =>
    checkWwwDrift({ metadataSource: "no site url here", structuredDataSource: wwwStructuredData }),
  );
});

test("checkWwwDrift: www changing the @id derivation template fails (read from source)", () => {
  const src = wwwStructuredData.replace("${SITE_URL}/#organization", "${SITE_URL}/#org");
  assert.ok(
    checkWwwDrift({ metadataSource: wwwMetadata, structuredDataSource: src }).some((e) =>
      e.includes("@id"),
    ),
  );
});

test("checkWwwDrift: www changing the Organization logo path fails (read from source, not self-derived)", () => {
  const src = wwwStructuredData.replace("${SITE_URL}/logo.png", "${SITE_URL}/brand.svg");
  assert.ok(
    checkWwwDrift({ metadataSource: wwwMetadata, structuredDataSource: src }).some((e) =>
      e.includes("logo"),
    ),
  );
});

test("checkWwwDrift: www dropping the org name or the github sameAs fails", () => {
  assert.ok(
    checkWwwDrift({
      metadataSource: wwwMetadata,
      structuredDataSource: wwwStructuredData.replace('name: "webhook.co"', 'name: "webhook"'),
    }).some((e) => e.includes("name")),
    "a changed org name must fail",
  );
  assert.ok(
    checkWwwDrift({
      metadataSource: wwwMetadata,
      structuredDataSource: wwwStructuredData.replace(
        '"https://github.com/webhook-co"',
        '"https://github.com/other"',
      ),
    }).some((e) => e.includes("sameAs")),
    "a changed github sameAs must fail",
  );
});

// ── checkAnalyticsBeacon: the CF Web Analytics beacon file (PR #2) ─────────────

// A syntactically-valid but obviously-fake 32-hex token, BUILT at runtime (never a 32-char literal in
// source) so the secret scanner can't mistake a test fixture for a leaked generic-api-key.
const FAKE_TOKEN = "a".repeat(32);

// The SHIPPED form: a CLASSIC injected <script> carrying the token in the data-cf-beacon attribute.
// Cloudflare's beacon resolves its own <script> via document.currentScript (null for MODULE scripts) or
// a script[data-cf-beacon] querySelector fallback, then reads the token from data-cf-beacon or ?token=.
// A classic script + attribute reports through both paths; a module + ?token= injection loads but
// silently reports nothing. The guard requires the attribute token and rejects module scripts.
// It must ALSO claim window.__cfBeacon with `load: "multi"` and pin the upload endpoint — see the
// two tests at the bottom of this block for why each is load-bearing.
const beacon = (token) =>
  `(function(){window.__cfBeacon={load:"multi"};` +
  `const s=document.createElement("script");s.defer=true;` +
  `s.src="https://static.cloudflareinsights.com/beacon.min.js";` +
  `s.setAttribute("data-cf-beacon",JSON.stringify({token:"${token}",` +
  `send:{to:"https://cloudflareinsights.com/cdn-cgi/rum"}}));` +
  `document.head.appendChild(s);})();`;

test("checkAnalyticsBeacon: a real 32-hex classic data-cf-beacon beacon passes", () => {
  assert.deepEqual(checkAnalyticsBeacon(beacon(FAKE_TOKEN)), []);
});

test("checkAnalyticsBeacon: the placeholder token fails (can't ship a dead beacon)", () => {
  assert.ok(checkAnalyticsBeacon(beacon("<CF_BEACON_TOKEN>")).length > 0);
});

test("checkAnalyticsBeacon: a non-32-hex token fails", () => {
  assert.ok(checkAnalyticsBeacon(beacon("nothex")).length > 0);
});

test("checkAnalyticsBeacon: a beacon missing the cloudflareinsights src fails", () => {
  const noSrc =
    `(function(){const s=document.createElement("script");` +
    `s.setAttribute("data-cf-beacon",JSON.stringify({token:"${FAKE_TOKEN}"}));` +
    `document.head.appendChild(s);})();`;
  assert.ok(checkAnalyticsBeacon(noSrc).some((e) => e.includes("beacon.min.js")));
});

test("checkAnalyticsBeacon: a MODULE-type beacon is rejected (currentScript is null → dead)", () => {
  // Verified against the live beacon.min.js: document.currentScript is always null for a module script,
  // so the beacon can't find its token and never reports. The guard must reject it, not pass it.
  const moduleForm =
    `(function(){const s=document.createElement("script");s.type="module";` +
    `s.src="https://static.cloudflareinsights.com/beacon.min.js";` +
    `s.setAttribute("data-cf-beacon",JSON.stringify({token:"${FAKE_TOKEN}"}));` +
    `document.head.appendChild(s);})();`;
  assert.ok(
    checkAnalyticsBeacon(moduleForm).some((e) => e.includes("module")),
    "a module-type beacon must be rejected",
  );
});

test("checkAnalyticsBeacon: a bare ?token= src (no data-cf-beacon attribute) is rejected", () => {
  // Without the attribute there is no querySelector fallback, so the beacon depends on currentScript
  // alone. Require the attribute form, which resolves through both paths.
  const queryForm =
    `(function(){const s=document.createElement("script");s.defer=true;` +
    `s.src="https://static.cloudflareinsights.com/beacon.min.js?token=${FAKE_TOKEN}";` +
    `document.head.appendChild(s);})();`;
  assert.ok(
    checkAnalyticsBeacon(queryForm).some((e) => e.includes("token")),
    "a bare ?token= src must be rejected",
  );
});

test('checkAnalyticsBeacon: a beacon that does not claim __cfBeacon with load:"multi" is rejected', () => {
  // THE REGRESSION THIS PINS (measured on the live docs site 2026-07-22): Mintlify's platform injects
  // its OWN Cloudflare beacon into <head> (token ec498eea…, version 2024.11.0). beacon.min.js opens
  // with `let p = window.__cfBeacon ? window.__cfBeacon : {}; if (p && "single" === p.load) return;`
  // and every instance stamps `p.load = "single"` on the way out. Theirs runs first, so OUR
  // runtime-appended script hit that early return and NEVER read our token — docs recorded 0 events
  // for 7 days while every page view was reported into Mintlify's account. Resetting the global to
  // `load: "multi"` is the ONLY thing that lets a second beacon run at all, so a version of this file
  // without it is a dead beacon that still looks correct.
  const noMulti =
    `(function(){const s=document.createElement("script");s.defer=true;` +
    `s.src="https://static.cloudflareinsights.com/beacon.min.js";` +
    `s.setAttribute("data-cf-beacon",JSON.stringify({token:"${FAKE_TOKEN}",` +
    `send:{to:"https://cloudflareinsights.com/cdn-cgi/rum"}}));` +
    `document.head.appendChild(s);})();`;
  assert.ok(
    checkAnalyticsBeacon(noMulti).some((e) => e.includes("__cfBeacon")),
    'a beacon that never sets window.__cfBeacon load:"multi" must be rejected',
  );
});

test("checkAnalyticsBeacon: a beacon that does not pin send.to is rejected", () => {
  // beacon.min.js picks its upload endpoint as:
  //   p.send && p.send.to ? p.send.to : (undefined === p.version ? "https://cloudflareinsights.com/cdn-cgi/rum" : null)
  // …and a null endpoint falls back to same-origin `/cdn-cgi/rum`. On docs.webhook.co that origin is
  // Mintlify's Cloudflare zone, which answers 204 and DROPS a token it does not own — the exact
  // failure that makes a broken beacon look healthy in DevTools. Since we now share the global with
  // their config, pin the documented manual-embed endpoint explicitly rather than inferring it from
  // the absence of `version`.
  const noSendTo =
    `(function(){window.__cfBeacon={load:"multi"};` +
    `const s=document.createElement("script");s.defer=true;` +
    `s.src="https://static.cloudflareinsights.com/beacon.min.js";` +
    `s.setAttribute("data-cf-beacon",JSON.stringify({token:"${FAKE_TOKEN}"}));` +
    `document.head.appendChild(s);})();`;
  assert.ok(
    checkAnalyticsBeacon(noSendTo).some((e) => e.includes("cloudflareinsights.com/cdn-cgi/rum")),
    "a beacon that does not pin the manual-embed upload endpoint must be rejected",
  );
});

test("checkAnalyticsBeacon: a COMMENT mentioning the right values cannot satisfy the guard", () => {
  // Caught by ai-review on PR #749, and reproduced before fixing: the guard used to text-scan for
  // `__cfBeacon =` and `load: "multi"` INDEPENDENTLY, and cf-analytics.js documents both in its header
  // comment. So flipping the REAL assignment to "single" — which hands the page back to Mintlify's
  // beacon and returns us to zero events — still satisfied a text scan, because the prose alone
  // matched. A guard that a comment can satisfy is not a guard. This is why the check now EXECUTES the
  // file and inspects what it actually did (see [[guard-scripts-must-parse-not-scan]]).
  const sabotaged = [
    `// Resetting the global to \`load: "multi"\` is what lets a second beacon run at all.`,
    `(function(){window.__cfBeacon={load:"single"};`,
    `const s=document.createElement("script");s.defer=true;`,
    `s.src="https://static.cloudflareinsights.com/beacon.min.js";`,
    `s.setAttribute("data-cf-beacon",JSON.stringify({token:"${FAKE_TOKEN}",`,
    `send:{to:"https://cloudflareinsights.com/cdn-cgi/rum"}}));`,
    `document.head.appendChild(s);})();`,
  ].join("\n");
  assert.ok(
    checkAnalyticsBeacon(sabotaged).some((e) => e.includes("__cfBeacon")),
    'a real `load: "single"` assignment must be rejected even when a comment says "multi"',
  );
});

test("checkAnalyticsBeacon: an endpoint that merely CONTAINS the pinned URL is rejected", () => {
  // The endpoint used to be checked with a substring scan, which CodeQL flagged as
  // js/incomplete-url-substring-sanitization — correctly: a substring match accepts any host that has
  // the real URL somewhere inside it, so a typosquatted or wrapping endpoint would sail through the
  // one guard whose whole job is pinning where our data goes. Compare it exactly.
  const wrappedEndpoint =
    `(function(){window.__cfBeacon={load:"multi"};` +
    `const s=document.createElement("script");s.defer=true;` +
    `s.src="https://static.cloudflareinsights.com/beacon.min.js";` +
    `s.setAttribute("data-cf-beacon",JSON.stringify({token:"${FAKE_TOKEN}",` +
    `send:{to:"https://evil.example/?u=https://cloudflareinsights.com/cdn-cgi/rum"}}));` +
    `document.head.appendChild(s);})();`;
  assert.ok(
    checkAnalyticsBeacon(wrappedEndpoint).some((e) =>
      e.includes("cloudflareinsights.com/cdn-cgi/rum"),
    ),
    "an endpoint that only contains the pinned URL must be rejected",
  );
});
