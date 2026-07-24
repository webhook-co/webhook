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
  fetchFeeds,
  registerSecret,
  run,
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
  // The WRITE path needs the redirect refusal as much as the reads — arguably more, since it carries
  // a body. Asserting it only on the GET path let a POST-only regression leak the query-string key.
  assert.equal(seen.init.redirect, "error");
  assert.equal(seen.init.referrerPolicy, "no-referrer");
});

// ⚠️ This test previously could not fail. Its fixture body never contained the key and the thrown
// message never included the request URL, so `!message.includes(KEY)` was true by construction —
// green even with redact() stubbed to the identity. The fixture now ECHOES the key back, the way a
// real upstream 4xx quoting the request would, so the assertion has something to catch.
test("submitUrlBatch: a failed request throws with the key redacted from the message", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    text: async () =>
      JSON.stringify({
        ErrorCode: 14,
        Message: `ERROR!!! NotAuthorized for apikey=${KEY}`,
        echoedKey: KEY,
      }),
  });
  await assert.rejects(
    () => submitUrlBatch(KEY, "https://webhook.co/", ["https://www.webhook.co/vs"], { fetchImpl }),
    (e) => {
      assert.ok(!e.message.includes(KEY), "error message leaked the API key");
      assert.match(e.message, /REDACTED/);
      assert.match(e.message, /NotAuthorized/);
      return true;
    },
  );
});

// Same vacuity check on the READ path: getJson builds a URL containing the key, and a non-ok
// response interpolates the body into the thrown message.
test("a failed READ throws with the key redacted, even when upstream echoes it back", async () => {
  registerSecret(KEY);
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    text: async () => `denied for apikey=${KEY}`,
  });
  await assert.rejects(
    () => fetchFeeds(KEY, "https://webhook.co/", { fetchImpl }),
    (e) => {
      assert.ok(!e.message.includes(KEY), "read-path error leaked the API key");
      assert.match(e.message, /REDACTED/);
      return true;
    },
  );
});

// ─── Findings from the PR #786 AI review ────────────────────────────────────────────────────────
// The first two are the load-bearing ones: the dry-run safety property was asserted on the ARGUMENT
// PARSER, not on the behaviour it is supposed to govern. A regression that always submitted would
// have passed the old suite — the exact failure mode of "a guard's tests must run the guard."

// The property is "performs no WRITE", not "performs no I/O" — the dry run deliberately reads the
// quota so the operator sees the budget before confirming. So the fake serves reads and detonates
// on any POST, which is the thing that must never happen without --confirm.
const readsOnlyFetch = (calls) => async (url, init) => {
  calls.push({ url, method: init?.method ?? "GET" });
  if ((init?.method ?? "GET") !== "GET") throw new Error(`WROTE without --confirm: ${init.method}`);
  return { ok: true, status: 200, text: async () => JSON.stringify({ d: { DailyQuota: 100 } }) };
};

test("run: `submit` without --confirm performs no write", async () => {
  const out = [];
  const calls = [];
  const code = await run(["submit", "https://www.webhook.co/vs"], {
    fetchImpl: readsOnlyFetch(calls),
    env: { BING_WEBMASTER_API_KEY: KEY },
    log: (m) => out.push(m),
  });
  assert.equal(code, 0);
  assert.match(out.join("\n"), /DRY RUN/);
  assert.equal(
    calls.filter((c) => c.method !== "GET").length,
    0,
    "dry run issued a non-GET request",
  );
  assert.equal(
    calls.filter((c) => /SubmitUrlbatch/.test(c.url)).length,
    0,
    "dry run hit the submission endpoint",
  );
});

test("run: `submit --confirm` POSTs exactly once to SubmitUrlbatch", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET" });
    return { ok: true, status: 200, text: async () => JSON.stringify({ d: { DailyQuota: 100 } }) };
  };
  const code = await run(["submit", "--confirm", "https://www.webhook.co/vs"], {
    fetchImpl,
    env: { BING_WEBMASTER_API_KEY: KEY },
    log: () => {},
  });
  assert.equal(code, 0);
  const posts = calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 1, "expected exactly one POST");
  assert.match(posts[0].url, /SubmitUrlbatch/);
});

test("submitUrlBatch: refuses a foreign siteUrl on the WRITE path, before the network", async () => {
  await assert.rejects(
    () =>
      submitUrlBatch(KEY, "https://evil.com/", ["https://www.webhook.co/vs"], {
        fetchImpl: neverFetch,
      }),
    /not an allowed site/,
  );
});

// Defence in depth. redact() keyed only on the `apikey=` parameter, so a key echoed back in a
// response body — or interpolated anywhere that is not a query string — would print in full.
test("redact: scrubs a registered key value even when it is not in an apikey= parameter", () => {
  registerSecret(KEY);
  assert.ok(!redact(`upstream said: your key ${KEY} is invalid`).includes(KEY));
});

// The key rides in the query string, so following a redirect would hand it to the redirect target.
test("getJson-family requests refuse to follow redirects", async () => {
  let init;
  const fetchImpl = async (_u, i) => {
    init = i;
    return { ok: true, status: 200, text: async () => JSON.stringify({ d: [] }) };
  };
  await fetchFeeds(KEY, "https://webhook.co/", { fetchImpl });
  assert.equal(init.redirect, "error");
  assert.equal(init.referrerPolicy, "no-referrer");
});
