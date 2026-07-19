#!/usr/bin/env node
// Entity-consolidation guard for the Mintlify docs (apps/docs). Wired into `pnpm lint`.
//
// Mintlify auto-emits a JSON-LD @graph on every docs page, INCLUDING an Organization node. Left
// alone it scopes that node to the docs host (@id=https://docs.webhook.co/#organization) with a
// mintcdn logo — a SEPARATE entity from the marketing site's Organization
// (@id=https://www.webhook.co/#organization). Two subdomains declaring two different organizations
// is precisely the entity-resolution failure behind "webhook.co doesn't rank for its own name".
//
// docs.json `seo.organization` retargets that auto-emitted node (verified: Mintlify honors a
// cross-host @id verbatim and re-points WebSite.publisher/TechArticle.publisher to it). This guard
// asserts docs.json carries a seo.organization that byte-matches www's REAL Organization node, so a
// future edit can't silently drop the fix, fabricate a sameAs, or point at the wrong host.
//
// It PARSES docs.json (JSON) — never text-scans it (guard-scripts-must-parse-not-scan). It carries a
// fail-closed FLOOR: a missing seo.organization, or an unreadable/mismatched www source, FAILS rather
// than passing vacuously (a-guards-tests-must-run-the-guard). apps/docs has no external CI, so this
// runs in the required `lint` job; the actual RENDERED output is proven separately by the
// post-deploy live check (docs-live-structured-data-check.mjs) — source presence here is necessary,
// not sufficient.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { isMain } from "./lib/docs-lib.mjs";

const ROOT = process.cwd();

// The webhook.co Organization, canonical on www. SOURCE OF TRUTH:
// apps/www/src/components/marketing/structured-data.tsx (organizationNode) + app/metadata.ts
// (SITE_URL="https://www.webhook.co"). Hard-coded here as literals — this runs as plain Node and
// apps/docs is not a workspace, so it can't import the TSX (same discipline as check-seo-html.mjs
// hard-coding HOST). checkWwwDrift() below re-reads that source and fails closed if it ever changes,
// so these literals can't silently drift out of sync with www.
export const EXPECTED = Object.freeze({
  id: "https://www.webhook.co/#organization",
  name: "webhook.co",
  url: "https://www.webhook.co",
  logo: "https://www.webhook.co/logo.png",
  sameAs: Object.freeze(["https://github.com/webhook-co"]),
});

const arraysEqual = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Validate the docs.json `seo.organization` block against www's canonical Organization. Returns an
 * array of human-readable error strings (empty = OK). A missing block is the FLOOR failure.
 */
export function checkSeoOrganization(config) {
  const org = config?.seo?.organization;
  if (!org || typeof org !== "object") {
    return [
      "seo.organization is missing from apps/docs/docs.json — the docs Organization entity is not " +
        `consolidated with www (expected @id ${EXPECTED.id}).`,
    ];
  }
  const errors = [];
  if (org.id !== EXPECTED.id)
    errors.push(`seo.organization.id is "${org.id}" — expected "${EXPECTED.id}" (must match www).`);
  if (org.name !== EXPECTED.name)
    errors.push(`seo.organization.name is "${org.name}" — expected "${EXPECTED.name}".`);
  if (org.url !== EXPECTED.url)
    errors.push(`seo.organization.url is "${org.url}" — expected "${EXPECTED.url}".`);
  if (org.logo !== EXPECTED.logo)
    errors.push(`seo.organization.logo is "${org.logo}" — expected "${EXPECTED.logo}".`);
  if (!arraysEqual(org.sameAs, EXPECTED.sameAs))
    errors.push(
      `seo.organization.sameAs is ${JSON.stringify(org.sameAs)} — expected ` +
        `${JSON.stringify(EXPECTED.sameAs)} (match www exactly; never fabricate a profile).`,
    );
  return errors;
}

/**
 * Extract `SITE_URL` from apps/www's metadata source. Throws (fail-closed) when it's absent, so a www
 * refactor that hides it can't make the drift check pass vacuously.
 */
export function extractSiteUrl(metadataSource) {
  const m = /export\s+const\s+SITE_URL\s*=\s*["']([^"']+)["']/.exec(metadataSource ?? "");
  if (!m) throw new Error("could not extract SITE_URL from apps/www/src/app/metadata.ts");
  return m[1];
}

/**
 * Drift guard: confirm www's SOURCE still produces EXPECTED. `SITE_URL` (from metadata.ts) drives the
 * @id and url, so those are derived from it (throwing if it can't be read). The @id-derivation, logo,
 * name, and sameAs are checked by floored existence against organizationNode-UNIQUE source patterns
 * (the `${SITE_URL}/#organization` and `${SITE_URL}/logo.png` interpolations don't appear on any other
 * node) — read from www's source, never self-derived, so a www refactor of any of them fails loudly
 * here instead of letting docs silently diverge.
 */
export function checkWwwDrift({ metadataSource, structuredDataSource }) {
  const siteUrl = extractSiteUrl(metadataSource); // throws → fail closed
  const errors = [];
  if (`${siteUrl}/#organization` !== EXPECTED.id)
    errors.push(
      `www SITE_URL "${siteUrl}" yields @id "${siteUrl}/#organization", not EXPECTED.id ` +
        `"${EXPECTED.id}" — reconcile docs.json + this guard with www.`,
    );
  if (siteUrl !== EXPECTED.url)
    errors.push(`www SITE_URL "${siteUrl}" no longer equals EXPECTED.url "${EXPECTED.url}".`);
  // Anchor each remaining field to a fixed substring READ from www's organizationNode source. The two
  // `${SITE_URL}`-interpolation needles are literal (double-quoted): they confirm www still derives the
  // @id and logo from SITE_URL, and they're unique to organizationNode (name is shared with websiteNode,
  // so it's the weakest anchor — but the @id/logo/sameAs anchors pin the node).
  const src = structuredDataSource ?? "";
  const anchors = [
    ["@id derivation", "ORG_ID = `${SITE_URL}/#organization`"],
    ["logo", "logo: `${SITE_URL}/logo.png`"],
    ["name", `name: "${EXPECTED.name}"`],
    ["sameAs", `"${EXPECTED.sameAs[0]}"`],
  ];
  for (const [field, needle] of anchors) {
    if (!src.includes(needle))
      errors.push(
        `apps/www structured-data no longer contains the Organization ${field} (${needle}) — ` +
          "reconcile docs with www.",
      );
  }
  return errors;
}

/**
 * Validate the Cloudflare Web Analytics beacon file (apps/docs/cf-analytics.js, PR #2). Only invoked
 * when the file exists. The token is public (embedded in every page's HTML), so it's fine in-repo —
 * but a placeholder or malformed token would ship a dead beacon, so require a real 32-hex token.
 */
export function checkAnalyticsBeacon(jsSource) {
  const src = jsSource ?? "";
  const errors = [];
  if (!src.includes("static.cloudflareinsights.com/beacon.min.js"))
    errors.push("cf-analytics.js does not reference static.cloudflareinsights.com/beacon.min.js.");
  const m = /token:\s*["']([^"']*)["']/.exec(src);
  const token = m?.[1];
  if (!token) errors.push("cf-analytics.js has no data-cf-beacon token.");
  // The CF beacon token is PUBLIC (rendered into every page's HTML); this is a build-time equality
  // check against a placeholder, not a secret comparison, so constant-time matching is irrelevant.
  // eslint-disable-next-line security/detect-possible-timing-attacks
  else if (token === "<CF_BEACON_TOKEN>")
    errors.push(
      "cf-analytics.js still holds the <CF_BEACON_TOKEN> placeholder — supply the real token.",
    );
  else if (!/^[0-9a-f]{32}$/.test(token))
    errors.push(`cf-analytics.js token "${token}" is not a 32-char hex Cloudflare beacon token.`);
  return errors;
}

async function readOrNull(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

if (isMain(import.meta.url)) {
  const docsJsonPath = join(ROOT, "apps/docs/docs.json");
  const metadataPath = join(ROOT, "apps/www/src/app/metadata.ts");
  const structuredDataPath = join(ROOT, "apps/www/src/components/marketing/structured-data.tsx");
  const beaconPath = join(ROOT, "apps/docs/cf-analytics.js");

  const errors = [];

  // (1) docs.json seo.organization matches www's Organization.
  const rawDocsJson = await readOrNull(docsJsonPath);
  if (rawDocsJson === null) {
    console.error(`✗ docs-structured-data-guard: cannot read ${docsJsonPath}`);
    process.exit(1);
  }
  let config;
  try {
    config = JSON.parse(rawDocsJson);
  } catch (err) {
    console.error(
      `✗ docs-structured-data-guard: apps/docs/docs.json is not valid JSON: ${err.message}`,
    );
    process.exit(1);
  }
  errors.push(...checkSeoOrganization(config));

  // (2) Drift: www's source must still produce EXPECTED (fail closed if unreadable).
  const metadataSource = await readOrNull(metadataPath);
  const structuredDataSource = await readOrNull(structuredDataPath);
  if (metadataSource === null || structuredDataSource === null) {
    console.error(
      "✗ docs-structured-data-guard: cannot read apps/www metadata/structured-data — refusing to " +
        "pass without confirming the docs Organization still matches www.",
    );
    process.exit(1);
  }
  try {
    errors.push(...checkWwwDrift({ metadataSource, structuredDataSource }));
  } catch (err) {
    console.error(`✗ docs-structured-data-guard: ${err.message}`);
    process.exit(1);
  }

  // (3) Analytics beacon — only when it exists (lands in PR #2 with a real token).
  const beaconSource = await readOrNull(beaconPath);
  if (beaconSource !== null) errors.push(...checkAnalyticsBeacon(beaconSource));

  if (errors.length) {
    console.error("✖ docs structured-data / entity problems:\n");
    for (const e of errors) console.error(`  ${e}`);
    console.error(
      "\napps/docs has no external CI but this gate does. The docs Organization must consolidate " +
        "with www; fix apps/docs/docs.json seo.organization (or reconcile with apps/www).",
    );
    process.exit(1);
  }
  console.log(
    `✔ docs structured-data OK — seo.organization consolidates onto ${EXPECTED.id}` +
      `${beaconSource !== null ? ", CF beacon wired" : ""}.`,
  );
}
