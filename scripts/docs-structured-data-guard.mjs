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
import { runInNewContext } from "node:vm";

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
  // Mirror www's Organization sameAs EXACTLY, in the same order — every entry is a REAL,
  // founder-confirmed profile (never fabricate one). checkWwwDrift() below re-reads www's actual
  // Organization sameAs and fails closed if it ever diverges (add OR remove), so docs can't silently
  // fall out of sync when www wires a new off-site profile.
  sameAs: Object.freeze([
    "https://github.com/webhook-co",
    "https://www.linkedin.com/company/webhook-co",
    "https://www.crunchbase.com/organization/webhook-co",
  ]),
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
 * Extract the Organization node's `sameAs` URLs from apps/www's structured-data source. Scoped to the
 * organizationNode() body (up to the next `export function`) so it never captures the Person node's
 * sameAs. Throws (fail-closed) when the node or its sameAs array can't be found, so a www refactor
 * can't make the drift check pass vacuously.
 */
export function extractOrgSameAs(structuredDataSource) {
  const src = structuredDataSource ?? "";
  const start = src.indexOf("function organizationNode");
  if (start === -1)
    throw new Error("could not find organizationNode() in apps/www structured-data");
  const after = src.slice(start);
  const nextFn = after.indexOf("export function", 1);
  const body = nextFn === -1 ? after : after.slice(0, nextFn);
  const arr = /sameAs:\s*\[([\s\S]*?)\]/.exec(body);
  if (!arr)
    throw new Error("could not find the Organization sameAs array in apps/www structured-data");
  return [...arr[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
}

/**
 * Drift guard: confirm www's SOURCE still produces EXPECTED. `SITE_URL` (from metadata.ts) drives the
 * @id and url, so those are derived from it (throwing if it can't be read). The @id-derivation, logo,
 * and name are checked by floored existence against organizationNode-UNIQUE source patterns (the
 * `${SITE_URL}/#organization` and `${SITE_URL}/logo.png` interpolations don't appear on any other node).
 * sameAs is compared EXACTLY: we read www's actual Organization sameAs and require it to equal
 * EXPECTED.sameAs — so a www edit that ADDS a profile (which would silently make docs a subset), not
 * just one that removes the github entry, fails loudly here instead of letting docs diverge.
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
  // Anchor the @id-derivation, logo, and name to fixed substrings READ from www's organizationNode
  // source. The two `${SITE_URL}`-interpolation needles are literal (double-quoted): they confirm www
  // still derives the @id and logo from SITE_URL, and are unique to organizationNode (name is shared
  // with websiteNode, so it's the weakest anchor — but the @id/logo anchors pin the node).
  const src = structuredDataSource ?? "";
  const anchors = [
    ["@id derivation", "ORG_ID = `${SITE_URL}/#organization`"],
    ["logo", "logo: `${SITE_URL}/logo.png`"],
    ["name", `name: "${EXPECTED.name}"`],
  ];
  for (const [field, needle] of anchors) {
    if (!src.includes(needle))
      errors.push(
        `apps/www structured-data no longer contains the Organization ${field} (${needle}) — ` +
          "reconcile docs with www.",
      );
  }
  // sameAs: exact-array comparison against www's ACTUAL Organization sameAs (fail closed if unreadable).
  let orgSameAs = null;
  try {
    orgSameAs = extractOrgSameAs(structuredDataSource);
  } catch (e) {
    errors.push(`could not read www Organization sameAs (${e.message}) — reconcile docs with www.`);
  }
  if (orgSameAs && !arraysEqual(orgSameAs, EXPECTED.sameAs))
    errors.push(
      `www Organization sameAs is ${JSON.stringify(orgSameAs)} but EXPECTED.sameAs is ` +
        `${JSON.stringify(EXPECTED.sameAs)} — docs.json seo.organization must mirror www's Organization ` +
        "sameAs exactly (add/remove entries in both, in the same order).",
    );
  return errors;
}

/**
 * Validate the Cloudflare Web Analytics beacon file (apps/docs/cf-analytics.js, PR #2). Only invoked
 * when the file exists. The token is public (embedded in every page's HTML), so it's fine in-repo —
 * but a placeholder, malformed token, or the wrong injection form would ship a DEAD beacon (a
 * measurement that doesn't measure), so pin the one form that reports.
 *
 * apps/docs/cf-analytics.js is Mintlify custom JS that injects the beacon <script> at runtime.
 * Cloudflare's beacon locates its own <script> via `document.currentScript` (or a
 * `script[data-cf-beacon]` querySelector fallback), then reads the token from the `data-cf-beacon`
 * attribute or the src `?token=`. Two traps this guard closes, both verified against the live
 * beacon.min.js: (1) `document.currentScript` is ALWAYS null for a module script, so a module +
 * `?token=` injection loads but never reports — reject any module script; (2) a bare `?token=` src has
 * no attribute for the querySelector fallback, so it depends on currentScript alone — require the
 * `data-cf-beacon` attribute token, which resolves through BOTH paths.
 */
/** The one upload endpoint we accept, compared with `===` — never a substring scan. */
const CF_MANUAL_UPLOAD_ENDPOINT = "https://cloudflareinsights.com/cdn-cgi/rum";
const CF_BEACON_SRC = "https://static.cloudflareinsights.com/beacon.min.js";

/**
 * RUN the beacon file against a stub DOM and report what it actually did.
 *
 * Deliberately an execution, not a text scan. The previous text-scan version searched for
 * `__cfBeacon =` and `load: "multi"` INDEPENDENTLY — and cf-analytics.js documents both in its header
 * comment, so flipping the real assignment to `"single"` (which hands the page back to Mintlify's
 * beacon and returns us to zero events) still satisfied the guard on the strength of the prose alone.
 * Caught by ai-review on PR #749 and reproduced before fixing. Executing removes that whole class:
 * comments cannot append a script, and every assertion below becomes exact equality on a real value
 * (which is also what closes the CodeQL substring-sanitization findings the scan version raised).
 *
 * The sandbox is deliberately tiny — a document that only knows createElement/head.appendChild — so
 * the file gets no ambient capability, and anything it touches beyond that surface throws and is
 * reported rather than silently ignored. Input is a committed repo file, not user data.
 */
function runBeaconSource(jsSource) {
  const appended = [];
  const makeElement = () => {
    const attrs = new Map();
    return {
      attrs,
      setAttribute: (k, v) => attrs.set(k, v),
      getAttribute: (k) => attrs.get(k),
    };
  };
  const sandbox = {
    window: {},
    document: {
      createElement: makeElement,
      head: { appendChild: (el) => appended.push(el) },
    },
  };
  sandbox.window.document = sandbox.document;
  // `globalThis.window` must resolve inside the vm too — cf-analytics.js assigns window.__cfBeacon.
  runInNewContext(jsSource, sandbox, { timeout: 1000 });
  return { appended, cfBeacon: sandbox.window.__cfBeacon };
}

export function checkAnalyticsBeacon(jsSource) {
  const errors = [];
  let ran;
  try {
    ran = runBeaconSource(jsSource ?? "");
  } catch (err) {
    // FAIL-CLOSED FLOOR: a file that throws installs no beacon at all, so it can never be "fine".
    return [`cf-analytics.js threw while installing the beacon: ${err.message}`];
  }

  // (1) It must actually append a beacon <script>. A file that appends nothing reports nothing.
  // Matched on the PARSED origin+pathname (never a substring of the raw string, which would accept
  // an attacker-shaped host like static.cloudflareinsights.com.evil.test), while still recognising a
  // `?token=` query form so that shape is rejected below for its real reason, not for its URL.
  const beacon = ran.appended.find((el) => {
    try {
      const u = new URL(el.src);
      return u.origin + u.pathname === CF_BEACON_SRC;
    } catch {
      return false;
    }
  });
  if (!beacon) {
    errors.push(
      `cf-analytics.js did not append a <script> with src ${CF_BEACON_SRC} — nothing will report.`,
    );
    return errors;
  }

  // (2) It must be a CLASSIC script: `document.currentScript` is always null for a module script, so
  // Cloudflare's beacon can't find its element (or token) and never reports.
  if (beacon.type === "module")
    errors.push(
      "cf-analytics.js injects a module script — document.currentScript is null for modules, so " +
        "Cloudflare's beacon can't resolve its token and silently never reports. Inject a classic " +
        "<script> instead (no module type).",
    );

  // (3) The config must ride in the data-cf-beacon ATTRIBUTE — the form that resolves via both
  // document.currentScript AND the script[data-cf-beacon] querySelector fallback. A bare `?token=`
  // src depends on currentScript alone (and is outright dead under a module script).
  let config;
  try {
    config = JSON.parse(beacon.getAttribute("data-cf-beacon") ?? "");
  } catch {
    errors.push(
      "cf-analytics.js has no parseable data-cf-beacon attribute — set it to JSON carrying " +
        "`token` so Cloudflare's beacon resolves it through both currentScript and the querySelector " +
        "fallback (a bare ?token= src is fragile and dead under a module script).",
    );
    return errors;
  }

  const token = config.token;
  // The CF beacon token is PUBLIC (rendered into every page's HTML); these are build-time equality
  // checks against a placeholder, not secret comparisons, so constant-time matching is irrelevant.
  // eslint-disable-next-line security/detect-possible-timing-attacks
  if (token === "<CF_BEACON_TOKEN>")
    errors.push(
      "cf-analytics.js still holds the <CF_BEACON_TOKEN> placeholder — supply the real token.",
    );
  else if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token))
    errors.push(`cf-analytics.js token "${token}" is not a 32-char hex Cloudflare beacon token.`);

  // (4) Mintlify's platform injects its OWN Cloudflare beacon into <head>, and beacon.min.js is
  // single-instance by default: it opens with `if (p && "single" === p.load) return;` and every
  // instance stamps `load: "single"` on the way out. Theirs wins the race, so without resetting the
  // global ours returns before it ever reads our token. Measured 2026-07-22: docs recorded 0 events
  // for 7 days while the beacon looked perfectly healthy in DevTools.
  if (ran.cfBeacon?.load !== "multi")
    errors.push(
      'cf-analytics.js does not reset window.__cfBeacon with `load: "multi"` — Mintlify injects its ' +
        "own Cloudflare beacon first and beacon.min.js aborts every later instance " +
        '(`if (p && "single" === p.load) return;`), so ours would load and silently never report.',
    );

  // (5) Endpoint selection in beacon.min.js is
  //   p.send && p.send.to ? p.send.to : (undefined === p.version ? "<cloudflareinsights>" : null)
  // and a null endpoint means same-origin /cdn-cgi/rum. On docs.webhook.co that is MINTLIFY's
  // Cloudflare zone, which answers 204 and drops a token it does not own. We share the global with
  // their config, so pin the documented manual-embed endpoint — by EXACT equality, since a substring
  // match would accept any host merely containing it.
  if (config.send?.to !== CF_MANUAL_UPLOAD_ENDPOINT)
    errors.push(
      `cf-analytics.js does not pin the upload endpoint to ${CF_MANUAL_UPLOAD_ENDPOINT} ` +
        "— without an exact `send.to` the beacon can fall back to same-origin /cdn-cgi/rum, which on " +
        "docs.webhook.co is Mintlify's zone: it answers 204 and DROPS our events.",
    );
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
