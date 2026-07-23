#!/usr/bin/env node
// Google Search Console SITEMAP WRITE path — submit / delete / list a sitemap for the property.
//
// Why this is a separate script rather than a flag on the readers: the reporting scripts
// (gsc-provider-ranking.mjs, gsc-index-coverage.mjs) request the READ-ONLY scope and must keep doing so.
// Mutation lives here and nowhere else, and it is opt-in per call site — this file is the only caller
// that names WRITE_SCOPE. The service account itself is unchanged; nothing is granted in Google's
// console. Search Console's `siteFullUser` permission already allows sitemap submission, and a service
// account acting as itself needs no extra consent to request a wider scope.
//
// The one operation Search Console exposes for sitemaps is idempotent and reversible:
//   submit → PUT    /sites/{siteUrl}/sitemaps/{feedpath}   (re-submitting is a no-op re-stamp)
//   delete → DELETE /sites/{siteUrl}/sitemaps/{feedpath}   (removes the row; re-submittable)
// Deleting then re-submitting is the standard way to clear a Search Console record that is stuck
// pending — which is exactly what docs.webhook.co/sitemap.xml has been since 2026-07-13
// (internal/marketing/seo-indexation-diagnosis.md).
//
// Blast radius is bounded by assertSitemapUrlAllowed(): only https sitemaps on webhook.co and its
// subdomains are accepted, checked against the PARSED hostname so a lookalike host or an embedded URL
// cannot slip through. The check runs before any network call.
//
// Usage:
//   pnpm gsc-sitemap list
//   pnpm gsc-sitemap submit https://docs.webhook.co/sitemap.xml
//   pnpm gsc-sitemap delete https://docs.webhook.co/sitemap.xml

import { getAccessToken, loadServiceAccount, SITE_URL } from "./gsc-provider-ranking.mjs";
import { isMain } from "./lib/docs-lib.mjs";

const WMX_BASE = "https://searchconsole.googleapis.com/webmasters/v3";

/** The read-WRITE Search Console scope. Named here and only here — see the header note. */
export const WRITE_SCOPE = "https://www.googleapis.com/auth/webmasters";

/** The registrable domain we are allowed to touch. */
const ALLOWED_APEX = "webhook.co";

/**
 * Return `url` if it is an https sitemap on webhook.co or a subdomain; throw otherwise (pure).
 *
 * Checks the PARSED `hostname`, never the raw string: a substring/suffix test over the whole URL would
 * accept `https://evilwebhook.co/...` (no dot boundary) and `https://evil.com/https://www.webhook.co/...`
 * (our host in the path). Requiring the leading dot for subdomains is what makes `evilwebhook.co` fail
 * while `docs.webhook.co` passes.
 */
export function assertSitemapUrlAllowed(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Refusing "${url}": not a valid URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing "${url}": sitemaps must be https.`);
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== ALLOWED_APEX && !host.endsWith(`.${ALLOWED_APEX}`)) {
    throw new Error(`Refusing "${url}": host is not ${ALLOWED_APEX} or a subdomain of it.`);
  }
  return url;
}

/** Parse argv into an action + optional URL (pure). No default action — a bare run must not mutate. */
export function parseArgs(argv) {
  const [action, url] = argv;
  if (!["list", "submit", "delete"].includes(action)) {
    throw new Error(
      `Unknown action ${action ? `"${action}"` : "(none)"} — use list, submit or delete.`,
    );
  }
  if (action !== "list" && !url) {
    throw new Error(`"${action}" requires a sitemap URL.`);
  }
  return { action, url };
}

/** The per-sitemap endpoint. Both path segments are encoded — the feedpath is a full URL. */
function sitemapEndpoint(siteUrl, sitemapUrl) {
  return `${WMX_BASE}/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`;
}

async function mutate(method, token, sitemapUrl, { fetchImpl = fetch, siteUrl = SITE_URL } = {}) {
  assertSitemapUrlAllowed(sitemapUrl); // before the network, deliberately
  const res = await fetchImpl(sitemapEndpoint(siteUrl, sitemapUrl), {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    // A 2xx here is an empty body, so only the failure path needs reading. The response text is
    // Google's error envelope — it never contains our credential.
    throw new Error(`GSC ${method} ${sitemapUrl} failed: HTTP ${res.status} ${await res.text()}`);
  }
  return { method, sitemapUrl, status: res.status };
}

/** Submit (or re-submit) a sitemap. Idempotent. */
export async function submitSitemap(token, sitemapUrl, opts = {}) {
  return mutate("PUT", token, sitemapUrl, opts);
}

/** Delete a sitemap row from the Sitemaps report. Reversible by submitting it again. */
export async function deleteSitemap(token, sitemapUrl, opts = {}) {
  return mutate("DELETE", token, sitemapUrl, opts);
}

/** List submitted sitemaps (read-only view, used to show before/after state around a mutation). */
export async function listSitemaps(token, { fetchImpl = fetch, siteUrl = SITE_URL } = {}) {
  const res = await fetchImpl(`${WMX_BASE}/sites/${encodeURIComponent(siteUrl)}/sitemaps`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (json.error) throw new Error(`GSC sitemaps list failed: ${JSON.stringify(json.error)}`);
  return json.sitemap ?? [];
}

function printRows(rows) {
  for (const s of rows) {
    console.log(
      `  ${s.path}\n    submitted=${s.lastSubmitted ?? "?"} downloaded=${s.lastDownloaded ?? "NEVER"}` +
        ` pending=${Boolean(s.isPending)} type=${s.type ?? "(absent)"}` +
        ` errors=${s.errors ?? "?"} warnings=${s.warnings ?? "?"}`,
    );
  }
}

async function main() {
  const { action, url } = parseArgs(process.argv.slice(2));
  // `list` needs no write rights, so it does not ask for any.
  const scope = action === "list" ? undefined : WRITE_SCOPE;
  const token = await getAccessToken(loadServiceAccount(), scope ? { scope } : {});

  if (action === "list") {
    console.log(`# Submitted sitemaps — ${SITE_URL}`);
    printRows(await listSitemaps(token));
    return 0;
  }

  assertSitemapUrlAllowed(url); // fail before we announce an action we won't take
  console.log(`# ${action} ${url} — ${SITE_URL}`);
  const res =
    action === "submit" ? await submitSitemap(token, url) : await deleteSitemap(token, url);
  console.log(`  ok (HTTP ${res.status})\n`);

  console.log("# Sitemaps now:");
  printRows(await listSitemaps(token));
  return 0;
}

if (isMain(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
