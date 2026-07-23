import assert from "node:assert/strict";
import { test } from "node:test";

import { buildJwtClaims, SCOPE } from "./gsc-provider-ranking.mjs";
import {
  assertSitemapUrlAllowed,
  deleteSitemap,
  parseArgs,
  submitSitemap,
  WRITE_SCOPE,
} from "./gsc-sitemap-write.mjs";

// A fetch that must never be called. Any invocation fails the test loudly, which is how the
// "refuses before the network" guards below prove they short-circuit rather than merely erroring late.
const neverFetch = () => {
  throw new Error("network was contacted");
};

test("WRITE_SCOPE is the read-WRITE Search Console scope, distinct from the read-only one", () => {
  assert.equal(WRITE_SCOPE, "https://www.googleapis.com/auth/webmasters");
  assert.notEqual(WRITE_SCOPE, SCOPE);
});

test("buildJwtClaims: defaults to the READ-ONLY scope when no scope is passed", () => {
  // The load-bearing security property: the reporting scripts (gsc-ranking, gsc-coverage) call this
  // without a scope, so they must never silently acquire mutation rights just because a write path exists.
  const c = buildJwtClaims("sa@example.com", "https://oauth2.googleapis.com/token", 1000);
  assert.equal(c.scope, SCOPE);
  assert.match(c.scope, /\.readonly$/);
});

test("buildJwtClaims: an explicit scope is honoured, so write is opt-in per call site", () => {
  const c = buildJwtClaims(
    "sa@example.com",
    "https://oauth2.googleapis.com/token",
    1000,
    WRITE_SCOPE,
  );
  assert.equal(c.scope, WRITE_SCOPE);
});

test("assertSitemapUrlAllowed: accepts https sitemaps on webhook.co and its subdomains", () => {
  for (const u of [
    "https://webhook.co/sitemap.xml",
    "https://www.webhook.co/sitemap.xml",
    "https://docs.webhook.co/sitemap.xml",
    "https://docs.webhook.co/sitemap.xml?x=1",
  ]) {
    assert.equal(assertSitemapUrlAllowed(u), u, `expected ${u} to be allowed`);
  }
});

test("assertSitemapUrlAllowed: rejects non-https", () => {
  assert.throws(() => assertSitemapUrlAllowed("http://www.webhook.co/sitemap.xml"), /https/i);
});

test("assertSitemapUrlAllowed: rejects other registrable domains, including lookalikes", () => {
  for (const u of [
    "https://example.com/sitemap.xml",
    // Suffix-matching done naively on the whole URL string would wave these through.
    "https://evilwebhook.co/sitemap.xml",
    "https://webhook.co.evil.com/sitemap.xml",
    "https://evil.com/https://www.webhook.co/sitemap.xml",
  ]) {
    assert.throws(() => assertSitemapUrlAllowed(u), /webhook\.co/, `expected ${u} to be refused`);
  }
});

test("assertSitemapUrlAllowed: rejects a value that is not a URL at all", () => {
  assert.throws(() => assertSitemapUrlAllowed("not a url"), /not a valid URL/i);
});

test("parseArgs: recognises list, submit and delete", () => {
  assert.deepEqual(parseArgs(["list"]), { action: "list", url: undefined });
  assert.deepEqual(parseArgs(["submit", "https://docs.webhook.co/sitemap.xml"]), {
    action: "submit",
    url: "https://docs.webhook.co/sitemap.xml",
  });
  assert.deepEqual(parseArgs(["delete", "https://docs.webhook.co/sitemap.xml"]), {
    action: "delete",
    url: "https://docs.webhook.co/sitemap.xml",
  });
});

test("parseArgs: refuses an unknown action rather than defaulting to a mutating one", () => {
  assert.throws(
    () => parseArgs(["nuke", "https://docs.webhook.co/sitemap.xml"]),
    /unknown action/i,
  );
  assert.throws(() => parseArgs([]), /unknown action/i);
});

test("parseArgs: submit and delete require a URL", () => {
  assert.throws(() => parseArgs(["submit"]), /requires a sitemap URL/i);
  assert.throws(() => parseArgs(["delete"]), /requires a sitemap URL/i);
});

test("submitSitemap: PUTs to the encoded sitemaps endpoint with the bearer token", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 204, text: async () => "" };
  };
  await submitSitemap("tok", "https://docs.webhook.co/sitemap.xml", {
    fetchImpl,
    siteUrl: "sc-domain:webhook.co",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[0].init.headers.authorization, "Bearer tok");
  assert.equal(
    calls[0].url,
    "https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Awebhook.co" +
      "/sitemaps/https%3A%2F%2Fdocs.webhook.co%2Fsitemap.xml",
  );
});

test("deleteSitemap: DELETEs the same encoded endpoint", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 204, text: async () => "" };
  };
  await deleteSitemap("tok", "https://docs.webhook.co/sitemap.xml", {
    fetchImpl,
    siteUrl: "sc-domain:webhook.co",
  });
  assert.equal(calls[0].init.method, "DELETE");
  assert.match(calls[0].url, /\/sitemaps\/https%3A%2F%2Fdocs\.webhook\.co%2Fsitemap\.xml$/);
});

test("submitSitemap: surfaces an API failure instead of reporting success", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    text: async () => '{"error":{"message":"insufficient permission"}}',
  });
  await assert.rejects(
    () => submitSitemap("tok", "https://docs.webhook.co/sitemap.xml", { fetchImpl }),
    /403/,
  );
});

test("submitSitemap: refuses a foreign host BEFORE any network call", async () => {
  await assert.rejects(
    () => submitSitemap("tok", "https://evil.com/sitemap.xml", { fetchImpl: neverFetch }),
    /webhook\.co/,
  );
});

test("deleteSitemap: refuses a foreign host BEFORE any network call", async () => {
  await assert.rejects(
    () => deleteSitemap("tok", "https://evil.com/sitemap.xml", { fetchImpl: neverFetch }),
    /webhook\.co/,
  );
});
