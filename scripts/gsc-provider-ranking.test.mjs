import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

import {
  buildJwtClaims,
  formatRow,
  getAccessToken,
  isProviderPage,
  isoDaysAgo,
  loadServiceAccount,
  querySearchAnalytics,
  SCOPE,
  signServiceAccountJwt,
} from "./gsc-provider-ranking.mjs";

// A throwaway RSA key so the real RS256 signing path is exercised (never a real credential).
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA = {
  client_email: "gsc-reader@example.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
};

test("buildJwtClaims: correct iss/scope/aud + 1-hour expiry", () => {
  const c = buildJwtClaims(SA.client_email, SA.token_uri, 1000);
  assert.equal(c.iss, SA.client_email);
  assert.equal(c.scope, SCOPE);
  assert.equal(c.aud, SA.token_uri);
  assert.equal(c.iat, 1000);
  assert.equal(c.exp, 4600); // iat + 3600
});

test("signServiceAccountJwt: produces a 3-segment RS256 JWT", () => {
  const jwt = signServiceAccountJwt(SA, 1000);
  const parts = jwt.split(".");
  assert.equal(parts.length, 3);
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
  assert.ok(parts[2].length > 0); // a signature is present
});

test("isProviderPage: matches the programmatic prefixes only", () => {
  for (const url of [
    "https://www.webhook.co/test/stripe",
    "https://www.webhook.co/verify",
    "https://www.webhook.co/verify/",
    "https://docs.webhook.co/providers/stripe",
  ]) {
    assert.equal(isProviderPage(url), true, url);
  }
  for (const url of [
    "https://www.webhook.co/",
    "https://www.webhook.co/pricing",
    "https://docs.webhook.co/introduction",
    "not a url",
  ]) {
    assert.equal(isProviderPage(url), false, url);
  }
});

test("formatRow: maps GSC keys + metrics onto named dimensions", () => {
  const r = formatRow(
    {
      keys: ["https://www.webhook.co/test/stripe", "stripe webhook testing"],
      impressions: 12,
      clicks: 1,
      ctr: 0.083,
      position: 8.4,
    },
    ["page", "query"],
  );
  assert.equal(r.page, "https://www.webhook.co/test/stripe");
  assert.equal(r.query, "stripe webhook testing");
  assert.equal(r.impressions, 12);
  assert.equal(r.position, 8.4);
});

test("isoDaysAgo: an ISO yyyy-mm-dd, earlier for a larger offset", () => {
  const from = Date.parse("2026-07-21T00:00:00Z");
  assert.equal(isoDaysAgo(2, from), "2026-07-19");
  assert.equal(isoDaysAgo(30, from), "2026-06-21");
});

test("getAccessToken: exchanges the JWT via the injected fetch", async () => {
  let called = null;
  const fetchImpl = async (url, opts) => {
    called = { url, body: opts.body.toString() };
    return { json: async () => ({ access_token: "tok_123", expires_in: 3600 }) };
  };
  const token = await getAccessToken(SA, { fetchImpl, nowSec: 1000 });
  assert.equal(token, "tok_123");
  assert.equal(called.url, SA.token_uri);
  assert.match(called.body, /grant_type=urn.*jwt-bearer/);
  assert.match(called.body, /assertion=/);
});

test("getAccessToken: throws on a token-endpoint error", async () => {
  const fetchImpl = async () => ({ json: async () => ({ error: "invalid_grant" }) });
  await assert.rejects(
    () => getAccessToken(SA, { fetchImpl, nowSec: 1000 }),
    /token exchange failed/,
  );
});

test("querySearchAnalytics: returns rows and throws on API error", async () => {
  const ok = async () => ({ json: async () => ({ rows: [{ keys: ["/verify"], position: 3 }] }) });
  const rows = await querySearchAnalytics(
    "tok",
    { startDate: "a", endDate: "b" },
    { fetchImpl: ok },
  );
  assert.equal(rows.length, 1);

  const err = async () => ({ json: async () => ({ error: { message: "bad" } }) });
  await assert.rejects(
    () => querySearchAnalytics("tok", {}, { fetchImpl: err }),
    /GSC query failed/,
  );
});

test("loadServiceAccount: reads env JSON, else throws with guidance", () => {
  const sa = loadServiceAccount({ GSC_SERVICE_ACCOUNT_KEY: JSON.stringify({ client_email: "x" }) });
  assert.equal(sa.client_email, "x");
  assert.throws(() => loadServiceAccount({}), /No GSC credential/);
});
