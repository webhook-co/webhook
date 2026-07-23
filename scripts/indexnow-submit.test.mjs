import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertHostAllowed,
  assertUrlsMatchHost,
  buildPayload,
  chunk,
  INDEXNOW_KEY,
  keyLocationFor,
  MAX_URLS_PER_REQUEST,
  submitBatch,
  verifyKeyLive,
} from "./indexnow-submit.mjs";

// A fetch that must never be called: any invocation fails loudly. This is how the "refuses before the
// network" guards prove they short-circuit rather than erroring after a request has already gone out.
const neverFetch = () => {
  throw new Error("network was contacted");
};

test("INDEXNOW_KEY satisfies the protocol's format rules", () => {
  // indexnow.org: 8-128 characters, from a-z A-Z 0-9 and dashes.
  assert.ok(INDEXNOW_KEY.length >= 8 && INDEXNOW_KEY.length <= 128, "length out of range");
  assert.match(INDEXNOW_KEY, /^[a-zA-Z0-9-]+$/);
});

test("keyLocationFor: the key file lives at the ROOT of each host", () => {
  // Each host is a separate IndexNow property and needs its own copy of the file; a key on the apex
  // does NOT cover subdomains.
  assert.equal(keyLocationFor("www.webhook.co"), `https://www.webhook.co/${INDEXNOW_KEY}.txt`);
  assert.equal(keyLocationFor("docs.webhook.co"), `https://docs.webhook.co/${INDEXNOW_KEY}.txt`);
});

test("assertHostAllowed: accepts webhook.co and its subdomains", () => {
  for (const h of ["webhook.co", "www.webhook.co", "docs.webhook.co"]) {
    assert.equal(assertHostAllowed(h), h);
  }
});

test("assertHostAllowed: rejects other hosts, including lookalikes", () => {
  for (const h of ["example.com", "evilwebhook.co", "webhook.co.evil.com"]) {
    assert.throws(() => assertHostAllowed(h), /webhook\.co/, `expected ${h} refused`);
  }
});

test("assertUrlsMatchHost: passes when every URL is on the host", () => {
  const urls = ["https://www.webhook.co/", "https://www.webhook.co/pricing"];
  assert.equal(assertUrlsMatchHost("www.webhook.co", urls), urls);
});

test("assertUrlsMatchHost: throws and NAMES the offender on a host mismatch", () => {
  // IndexNow answers a host/urlList mismatch with 422, so catching it here turns a rejected batch
  // into a precise local error.
  assert.throws(
    () =>
      assertUrlsMatchHost("www.webhook.co", [
        "https://www.webhook.co/",
        "https://docs.webhook.co/introduction",
      ]),
    /docs\.webhook\.co\/introduction/,
  );
});

test("buildPayload: emits exactly the four protocol fields", () => {
  const p = buildPayload("www.webhook.co", ["https://www.webhook.co/"]);
  assert.deepEqual(Object.keys(p).sort(), ["host", "key", "keyLocation", "urlList"]);
  assert.equal(p.host, "www.webhook.co");
  assert.equal(p.key, INDEXNOW_KEY);
  assert.equal(p.keyLocation, keyLocationFor("www.webhook.co"));
  assert.deepEqual(p.urlList, ["https://www.webhook.co/"]);
});

test("chunk: splits at the protocol's per-request ceiling", () => {
  assert.equal(MAX_URLS_PER_REQUEST, 10_000);
  const many = Array.from({ length: 25_000 }, (_, i) => `https://www.webhook.co/${i}`);
  const parts = chunk(many, MAX_URLS_PER_REQUEST);
  assert.deepEqual(
    parts.map((p) => p.length),
    [10_000, 10_000, 5_000],
  );
  assert.deepEqual(chunk([], 10).length, 0);
});

test("verifyKeyLive: succeeds when the file serves the key verbatim", async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, keyLocationFor("www.webhook.co"));
    return { ok: true, status: 200, text: async () => INDEXNOW_KEY };
  };
  assert.equal(await verifyKeyLive("www.webhook.co", { fetchImpl }), true);
});

test("verifyKeyLive: tolerates a trailing newline in the served file", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => `${INDEXNOW_KEY}\n` });
  assert.equal(await verifyKeyLive("www.webhook.co", { fetchImpl }), true);
});

test("verifyKeyLive: throws when the key file is not deployed (404)", async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, text: async () => "not found" });
  await assert.rejects(() => verifyKeyLive("docs.webhook.co", { fetchImpl }), /404/);
});

test("verifyKeyLive: throws when the file serves something other than the key", async () => {
  // A host that returns a soft-404 HTML page would otherwise look like a live key file.
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => "<!doctype html>" });
  await assert.rejects(() => verifyKeyLive("docs.webhook.co", { fetchImpl }), /does not contain/i);
});

test("submitBatch: refuses to POST when the key file is not live", async () => {
  // The load-bearing guard: submitting against an unverified key wastes a submission and can get the
  // key rejected, so the check must happen BEFORE any POST.
  const fetchImpl = async (url) => {
    if (url.endsWith(".txt")) return { ok: false, status: 404, text: async () => "" };
    throw new Error("POSTed despite an unverified key");
  };
  await assert.rejects(
    () => submitBatch("www.webhook.co", ["https://www.webhook.co/"], { fetchImpl }),
    /404/,
  );
});

test("submitBatch: POSTs the payload as JSON once the key verifies", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (url.endsWith(".txt")) return { ok: true, status: 200, text: async () => INDEXNOW_KEY };
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => "" };
  };
  const res = await submitBatch("www.webhook.co", ["https://www.webhook.co/"], { fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "POST");
  assert.match(calls[0].init.headers["content-type"], /application\/json/);
  assert.deepEqual(
    JSON.parse(calls[0].init.body),
    buildPayload("www.webhook.co", ["https://www.webhook.co/"]),
  );
  assert.equal(res.status, 200);
});

test("submitBatch: surfaces a rejected submission instead of reporting success", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith(".txt")) return { ok: true, status: 200, text: async () => INDEXNOW_KEY };
    return { ok: false, status: 422, text: async () => "Unprocessable Entity" };
  };
  await assert.rejects(
    () => submitBatch("www.webhook.co", ["https://www.webhook.co/"], { fetchImpl }),
    /422/,
  );
});

test("submitBatch: refuses a host outside webhook.co before any network call", async () => {
  await assert.rejects(
    () => submitBatch("evil.com", ["https://evil.com/"], { fetchImpl: neverFetch }),
    /webhook\.co/,
  );
});
