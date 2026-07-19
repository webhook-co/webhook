import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EXPECTED,
  checkSeoOrganization,
  extractSiteUrl,
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
  org.sameAs = ["https://github.com/webhook-co", "https://x.com/webhookco"]; // invented profile
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

// ── checkWwwDrift: www's SOURCE must still produce EXPECTED ────────────────────

const wwwMetadata = `export const SITE_URL = "https://www.webhook.co";`;
const wwwStructuredData = `
export const ORG_ID = \`\${SITE_URL}/#organization\`;
export function organizationNode() {
  return { name: "webhook.co", url: SITE_URL, logo: \`\${SITE_URL}/logo.png\`,
    sameAs: ["https://github.com/webhook-co"] };
}`;

test("checkWwwDrift: passes when www's source still matches EXPECTED", () => {
  assert.deepEqual(
    checkWwwDrift({ metadataSource: wwwMetadata, structuredDataSource: wwwStructuredData }),
    [],
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
const beacon = (token) =>
  `(function(){var s=document.createElement("script");s.defer=true;` +
  `s.src="https://static.cloudflareinsights.com/beacon.min.js";` +
  `s.setAttribute("data-cf-beacon",JSON.stringify({token:"${token}"}));` +
  `document.head.appendChild(s);})();`;

test("checkAnalyticsBeacon: a real 32-hex token beacon passes", () => {
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
    `(function(){var s=document.createElement("script");` +
    `s.setAttribute("data-cf-beacon",JSON.stringify({token:"${FAKE_TOKEN}"}));})();`;
  assert.ok(checkAnalyticsBeacon(noSrc).some((e) => e.includes("beacon.min.js")));
});
