#!/usr/bin/env node
// Read-only Google Search Console ranking reader for the programmatic-SEO Wave-1 gate. Answers the
// falsifiable question the plan gates Waves 2-3 on: "do the provider pages actually RANK?" — reporting
// avg position / impressions / clicks / CTR for the programmatic path prefixes (www `/test/` tutorials,
// the `/verify` tool, docs `/providers/` references).
//
// Node built-ins only (no googleapis SDK), mirroring scripts/audit-prod.mjs. Auth is a service-account
// JWT — NOT interactive OAuth — so it runs unattended (a schedule or `pnpm gsc-ranking`). Credential:
//   GSC_SERVICE_ACCOUNT_KEY       the service-account JSON (as a string; e.g. a GitHub Actions secret), OR
//   GSC_SERVICE_ACCOUNT_KEY_FILE  a path to the JSON key file (for local runs).
// The service account (gsc-reader@webhook-co-app.iam.gserviceaccount.com) has read access to
// sc-domain:webhook.co (added under Search Console → Users and permissions). It is READ-ONLY
// (webmasters.readonly scope) — it cannot change anything in Search Console.
//
// Pure helpers (claims/JWT/row formatting/path filtering) are exported + unit-tested WITHOUT network;
// the fetch calls take an injectable `fetchImpl` so the test never touches Google.

import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";

import { isMain } from "./lib/docs-lib.mjs";

export const SITE_URL = "sc-domain:webhook.co";
export const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
// The programmatic estate's path prefixes (per the placement policy): www tutorials, the verifier, and
// the docs references (docs is a separate host but the same GSC domain property covers it).
export const PROVIDER_PATH_PREFIXES = ["/test/", "/verify", "/providers/"];

const API_BASE = "https://searchconsole.googleapis.com/webmasters/v3";

/** base64url of a string/Buffer (no padding). */
export function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** The JWT claim set for a service-account token exchange (pure — testable without crypto). */
export function buildJwtClaims(clientEmail, tokenUri, nowSec) {
  return {
    iss: clientEmail,
    scope: SCOPE,
    aud: tokenUri,
    iat: nowSec,
    exp: nowSec + 3600,
  };
}

/** Sign a service-account JWT (RS256) for the token exchange. */
export function signServiceAccountJwt(sa, nowSec) {
  const signingInput = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
    JSON.stringify(buildJwtClaims(sa.client_email, sa.token_uri, nowSec)),
  )}`;
  const signature = b64url(createSign("RSA-SHA256").update(signingInput).sign(sa.private_key));
  return `${signingInput}.${signature}`;
}

/** Exchange the JWT for a short-lived access token. */
export async function getAccessToken(
  sa,
  { fetchImpl = fetch, nowSec = Math.floor(Date.now() / 1000) } = {},
) {
  const jwt = signServiceAccountJwt(sa, nowSec);
  const res = await fetchImpl(sa.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const json = await res.json();
  if (!json.access_token) {
    throw new Error(`GSC token exchange failed: ${JSON.stringify(json)}`);
  }
  return json.access_token;
}

/** Run a Search Analytics query. `body` is the GSC query object (dates/dimensions/filters/rowLimit). */
export async function querySearchAnalytics(
  token,
  body,
  { fetchImpl = fetch, siteUrl = SITE_URL } = {},
) {
  const res = await fetchImpl(
    `${API_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const json = await res.json();
  if (json.error) throw new Error(`GSC query failed: ${JSON.stringify(json.error)}`);
  return json.rows ?? [];
}

/** True if a page URL is one of the programmatic provider pages (pure). */
export function isProviderPage(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  return PROVIDER_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

/** Normalize a GSC row (keys + metrics) to a flat record (pure). */
export function formatRow(row, dimensions) {
  const rec = {
    impressions: row.impressions ?? 0,
    clicks: row.clicks ?? 0,
    ctr: row.ctr ?? 0,
    position: row.position ?? 0,
  };
  dimensions.forEach((d, i) => {
    rec[d] = row.keys?.[i] ?? "";
  });
  return rec;
}

/** ISO date `days` ago (UTC). GSC finalizes data on a ~2-day lag, so the default window ends 2 days back. */
export function isoDaysAgo(days, from = Date.now()) {
  return new Date(from - days * 86_400_000).toISOString().slice(0, 10);
}

/** Load the service-account key from env (string) or a file path. */
export function loadServiceAccount(env = process.env) {
  if (env.GSC_SERVICE_ACCOUNT_KEY) return JSON.parse(env.GSC_SERVICE_ACCOUNT_KEY);
  if (env.GSC_SERVICE_ACCOUNT_KEY_FILE) {
    return JSON.parse(readFileSync(env.GSC_SERVICE_ACCOUNT_KEY_FILE, "utf8"));
  }
  throw new Error(
    "No GSC credential: set GSC_SERVICE_ACCOUNT_KEY (the service-account JSON) or " +
      "GSC_SERVICE_ACCOUNT_KEY_FILE (path to it). The service account needs read access to " +
      `${SITE_URL} in Search Console → Users and permissions.`,
  );
}

async function main() {
  const sa = loadServiceAccount();
  const token = await getAccessToken(sa);
  const startDate = isoDaysAgo(30);
  const endDate = isoDaysAgo(2);
  const window = `${startDate}..${endDate}`;

  // Per-(page, query) rows for the programmatic provider pages — the Wave-1 ranking signal.
  const byPageQuery = (
    await querySearchAnalytics(token, {
      startDate,
      endDate,
      dimensions: ["page", "query"],
      rowLimit: 1000,
    })
  )
    .map((r) => formatRow(r, ["page", "query"]))
    .filter((r) => isProviderPage(r.page));

  console.log(`# Programmatic-SEO Wave-1 ranking — sc-domain:webhook.co — ${window}\n`);
  if (byPageQuery.length === 0) {
    // Not an error: the provider pages aren't shipped/indexed yet. Report the site baseline so the run
    // is never a silent nothing.
    const site = await querySearchAnalytics(token, {
      startDate,
      endDate,
      dimensions: ["date"],
      rowLimit: 1,
    });
    const total = (await querySearchAnalytics(token, { startDate, endDate })).map((r) =>
      formatRow(r, []),
    )[0];
    console.log(
      "No programmatic provider pages (/test/ · /verify · /providers/) have impressions yet —",
    );
    console.log("Wave 1 pages are not shipped or not yet indexed. Baseline (whole site):");
    console.log(
      total
        ? `  impressions ${total.impressions} · clicks ${total.clicks} · avg position ${total.position.toFixed(1)}`
        : "  (no site data in window)",
    );
    console.log(`  (${site.length ? "site has search data" : "no site data"} in ${window})`);
    return 0;
  }

  byPageQuery.sort((a, b) => b.impressions - a.impressions);
  console.log(`${byPageQuery.length} provider-page × query rows with impressions:\n`);
  console.log("  pos   imp   clk   ctr%   page  ←  query");
  for (const r of byPageQuery.slice(0, 60)) {
    console.log(
      `  ${r.position.toFixed(1).padStart(5)} ${String(r.impressions).padStart(5)} ${String(r.clicks).padStart(5)} ` +
        `${(r.ctr * 100).toFixed(1).padStart(5)}   ${new URL(r.page).pathname}  ←  ${r.query}`,
    );
  }
  const ranked = byPageQuery.filter((r) => r.position <= 10).length;
  console.log(
    `\nWave-2 gate signal: ${ranked} provider-page × query pairs ranking page-1 (avg position ≤ 10).`,
  );
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
