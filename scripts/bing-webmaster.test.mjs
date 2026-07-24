import assert from "node:assert/strict";
import { test } from "node:test";

import {
  API_BASE,
  assertSiteAllowed,
  bingUrl,
  latestCrawlRow,
  parseArgs,
  parseDotNetDate,
  redact,
  submitUrlBatch,
  summarizeFeeds,
  summarizeSites,
} from "./bing-webmaster.mjs";

// A fetch that must never be called. Any invocation fails loudly, which is how the "refuses before
// the network" guards below prove they short-circuit rather than erroring late, after a request.
const neverFetch = () => {
  throw new Error("network was contacted");
};

// Deliberately a low-entropy, self-describing string rather than a realistic 32-char hex key.
// A hex fixture reads as a credential to gitleaks' generic-api-key rule (it failed CI on exactly
// that), and the honest fix is a fixture that is not secret-shaped — not an allow-comment that
// teaches the next reader to suppress the scanner. redact() matches on the `apikey=` parameter,
// not on the value's shape, so nothing here is weakened by the swap.
const KEY = "bing-test-key-not-a-real-secret";

test("bingUrl: builds the documented JSON endpoint with the key and site as query params", () => {
  const u = bingUrl("GetUserSites", KEY, { siteUrl: "https://webhook.co/" });
  assert.ok(u.startsWith(`${API_BASE}/GetUserSites?`));
  const q = new URL(u).searchParams;
  assert.equal(q.get("apikey"), KEY);
  assert.equal(q.get("siteUrl"), "https://webhook.co/");
});

// The load-bearing secret-hygiene property. The API key travels in the QUERY STRING, so any code path
// that logs a URL — an error message, a debug line, a thrown fetch failure — leaks the credential into
// a terminal and a transcript. Everything printed must go through redact() first.
test("redact: removes the apikey value from a URL so it can never be logged", () => {
  const u = bingUrl("GetFeeds", KEY, { siteUrl: "https://webhook.co/" });
  const safe = redact(u);
  assert.ok(!safe.includes(KEY), "redacted URL still contained the key");
  assert.match(safe, /apikey=REDACTED/);
  assert.match(safe, /GetFeeds/, "redaction should keep the method visible for debugging");
});

test("redact: scrubs the key wherever it appears, including inside an error message", () => {
  const msg = `request failed: ${API_BASE}/GetFeeds?apikey=${KEY}&siteUrl=x`;
  assert.ok(!redact(msg).includes(KEY));
});

test("assertSiteAllowed: accepts https hosts on webhook.co and its subdomains", () => {
  for (const s of ["https://webhook.co/", "https://www.webhook.co/", "https://docs.webhook.co/"]) {
    assert.doesNotThrow(() => assertSiteAllowed(s), `${s} should be allowed`);
  }
});

// Parsed-hostname comparison, not startsWith/includes. A substring check passes for
// `https://webhook.co.evil.com/`, which is exactly the incomplete-URL-substring-sanitization defect
// CodeQL flags at HIGH severity.
test("assertSiteAllowed: refuses a lookalike host that a substring check would admit", () => {
  for (const s of [
    "https://webhook.co.evil.com/",
    "https://notwebhook.co/",
    "https://evil.com/?x=https://webhook.co/",
    "http://webhook.co/",
  ]) {
    assert.throws(
      () => assertSiteAllowed(s),
      /not an allowed site|https/,
      `${s} should be refused`,
    );
  }
});

test("parseDotNetDate: converts the WCF /Date(ms)/ wire format to an ISO string", () => {
  assert.equal(parseDotNetDate("/Date(1784663759000)/"), "2026-07-21T19:55:59.000Z");
});

// The API returns a timezone offset suffix on some fields (`/Date(1784098800000-0700)/`). The epoch
// is already UTC, so the offset is presentational — parsing must ignore it rather than double-adjust.
test("parseDotNetDate: ignores a trailing timezone offset instead of shifting the instant", () => {
  assert.equal(
    parseDotNetDate("/Date(1784663759000-0700)/"),
    parseDotNetDate("/Date(1784663759000)/"),
  );
});

test("parseDotNetDate: returns null for a missing or unparseable value rather than throwing", () => {
  for (const v of [undefined, null, "", "not a date", "/Date()/"]) {
    assert.equal(parseDotNetDate(v), null);
  }
});

test("summarizeSites: reports only verification state, never the authentication codes", () => {
  const rows = summarizeSites([
    {
      Url: "https://webhook.co/",
      IsVerified: true,
      AuthenticationCode: "SECRETCODE",
      DnsVerificationCode: "abc.webhook.co",
    },
  ]);
  assert.deepEqual(rows, [{ url: "https://webhook.co/", verified: true }]);
  assert.ok(!JSON.stringify(rows).includes("SECRETCODE"));
});

test("summarizeFeeds: surfaces the fetch status and URL count per submitted sitemap", () => {
  const rows = summarizeFeeds([
    {
      Url: "https://docs.webhook.co/sitemap.xml",
      Status: "Success",
      UrlCount: 150,
      Submitted: "/Date(1783941073309)/",
      LastCrawled: "/Date(1784663759000)/",
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, "https://docs.webhook.co/sitemap.xml");
  assert.equal(rows[0].status, "Success");
  assert.equal(rows[0].urlCount, 150);
  assert.equal(rows[0].lastCrawled, "2026-07-21T19:55:59.000Z");
});

// A sitemap Bing accepted but never fetched has no LastCrawled. That is precisely the failure mode
// the docs sitemap hit on Google for ten days, so it must read as NEVER rather than crash or blank.
test("summarizeFeeds: a never-crawled feed reports lastCrawled null, not a throw", () => {
  const rows = summarizeFeeds([{ Url: "https://x.webhook.co/sitemap.xml", Status: "Pending" }]);
  assert.equal(rows[0].lastCrawled, null);
  assert.equal(rows[0].urlCount, 0);
});

test("latestCrawlRow: picks the most recent day, not the last array element", () => {
  const row = latestCrawlRow([
    { Date: "/Date(1784663759000)/", CrawledPages: 5, InIndex: 2, InLinks: 0 },
    { Date: "/Date(1784058800000)/", CrawledPages: 99, InIndex: 1, InLinks: 0 },
  ]);
  assert.equal(row.crawledPages, 5);
  assert.equal(row.inIndex, 2);
});

test("latestCrawlRow: returns null on an empty series rather than undefined-dereferencing", () => {
  assert.equal(latestCrawlRow([]), null);
});

test("parseArgs: defaults to the apex site and the crawl report", () => {
  const a = parseArgs([]);
  assert.equal(a.command, "crawl");
  assert.equal(a.siteUrl, "https://webhook.co/");
});

test("parseArgs: accepts a command and an explicit --site", () => {
  const a = parseArgs(["feeds", "--site", "https://www.webhook.co/"]);
  assert.equal(a.command, "feeds");
  assert.equal(a.siteUrl, "https://www.webhook.co/");
});

// Submission is a WRITE against a third party's index. It must be opt-in per invocation, so an
// operator who runs the command to see what it would do does not silently submit.
test("parseArgs: submission is a dry run unless --confirm is passed", () => {
  assert.equal(parseArgs(["submit", "https://www.webhook.co/vs"]).confirm, false);
  assert.equal(parseArgs(["submit", "--confirm", "https://www.webhook.co/vs"]).confirm, true);
});

test("submitUrlBatch: refuses a foreign URL before contacting the network", async () => {
  await assert.rejects(
    () =>
      submitUrlBatch(KEY, "https://webhook.co/", ["https://evil.com/x"], { fetchImpl: neverFetch }),
    /not an allowed site/,
  );
});

test("submitUrlBatch: refuses an empty batch rather than POSTing a no-op", async () => {
  await assert.rejects(
    () => submitUrlBatch(KEY, "https://webhook.co/", [], { fetchImpl: neverFetch }),
    /no URLs/,
  );
});

test("submitUrlBatch: POSTs the documented body shape and reports success", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, text: async () => JSON.stringify({ d: null }) };
  };
  const urls = ["https://www.webhook.co/vs", "https://www.webhook.co/test"];
  const out = await submitUrlBatch(KEY, "https://webhook.co/", urls, { fetchImpl });
  assert.equal(out.submitted, 2);
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers["Content-Type"], "application/json");
  const body = JSON.parse(seen.init.body);
  assert.equal(body.siteUrl, "https://webhook.co/");
  assert.deepEqual(body.urlList, urls);
});

test("submitUrlBatch: a failed request throws with the key redacted from the message", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ ErrorCode: 14, Message: "ERROR!!! NotAuthorized" }),
  });
  await assert.rejects(
    () => submitUrlBatch(KEY, "https://webhook.co/", ["https://www.webhook.co/vs"], { fetchImpl }),
    (e) => {
      assert.ok(!e.message.includes(KEY), "error message leaked the API key");
      assert.match(e.message, /NotAuthorized/);
      return true;
    },
  );
});
