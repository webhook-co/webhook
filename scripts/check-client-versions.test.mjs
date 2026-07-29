import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchRetrying, isRetryable, pickLatest } from "./check-client-versions.mjs";

// PyPI's info.version LAGS (it reported 0.2.1 for ~a minute after 0.3.0 shipped). Reading the release list
// instead is the whole point of this helper — so pin the case that motivated it.
test("picks the newest release even when PyPI's info.version still lags behind", () => {
  assert.equal(pickLatest(["0.1.0", "0.2.0", "0.2.1", "0.3.0"]), "0.3.0");
});

// The string trap: "0.10.0" sorts BELOW "0.9.0" lexicographically, but 10 > 9. Getting this wrong would
// make us advise everyone to "upgrade" to an older version.
test("orders NUMERICALLY, not lexicographically", () => {
  assert.equal(pickLatest(["0.9.0", "0.10.0"]), "0.10.0");
  assert.equal(pickLatest(["0.2.9", "0.2.10"]), "0.2.10");
  assert.equal(pickLatest(["1.0.0", "0.30.0"]), "1.0.0");
});

test("ignores prereleases and dev builds — only a stable release is 'latest'", () => {
  assert.equal(pickLatest(["0.3.0", "0.4.0rc1", "0.4.0.dev1"]), "0.3.0");
});

// Returning undefined here would sail through the comparison and silently mark a client "up to date".
test("throws rather than guess when there is no stable release", () => {
  assert.throws(() => pickLatest([]), /no stable releases/);
  assert.throws(() => pickLatest(["0.1.0rc1"]), /no stable releases/);
});

// ── Retrying a TRANSPORT failure, without ever retrying a real answer ──────────────────────────────────
//
// This guard reads three live registries, so it measured network luck as well as registry contents. On
// 2026-07-29 it reded a PR with `TypeError: fetch failed` / `read ECONNRESET` — nothing to do with the
// versions, which were correct. That is the same "teaches everyone to ignore a red check" failure this
// file's other comments already guard against, arriving by a different route.
//
// The line that matters: retry the TRANSPORT, never the ANSWER. A 404 is the registry telling us something
// true, and retrying it would only turn a fast honest failure into a slow one.

test("a network-layer failure is retryable", () => {
  assert.equal(isRetryable({ error: new TypeError("fetch failed") }), true);
});

test("5xx and 429 are retryable — the server is unwell, not answering", () => {
  assert.equal(isRetryable({ status: 500 }), true);
  assert.equal(isRetryable({ status: 502 }), true);
  assert.equal(isRetryable({ status: 429 }), true);
});

// The important negative: a 404 is a genuine answer. Retrying it would hide a deleted/renamed package
// behind three slow attempts and still fail.
test("a 4xx answer is NOT retried — that is the registry telling us something true", () => {
  assert.equal(isRetryable({ status: 404 }), false);
  assert.equal(isRetryable({ status: 403 }), false);
  assert.equal(isRetryable({ status: 200 }), false);
});

test("fetchRetrying recovers from a transient failure", async () => {
  let calls = 0;
  const res = await fetchRetrying("https://example.invalid/x", undefined, {
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) throw new TypeError("fetch failed");
      return { ok: true, status: 200 };
    },
    sleep: async () => {},
  });
  assert.equal(res.status, 200);
  assert.equal(calls, 3, "should have retried twice before succeeding");
});

test("fetchRetrying gives up and rethrows, naming the url and attempt count", async () => {
  let calls = 0;
  await assert.rejects(
    fetchRetrying("https://registry.example/pkg", undefined, {
      fetchImpl: async () => {
        calls += 1;
        throw new TypeError("fetch failed");
      },
      attempts: 3,
      sleep: async () => {},
    }),
    (err) => {
      assert.match(String(err.message), /registry\.example\/pkg/);
      assert.match(String(err.message), /3 attempts/);
      return true;
    },
  );
  assert.equal(calls, 3, "must stop at the attempt budget, not loop forever");
});

// Anti-vacuity: if a 404 were retried this would see more than one call.
test("a 404 costs exactly one request", async () => {
  let calls = 0;
  const res = await fetchRetrying("https://registry.example/gone", undefined, {
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 404 };
    },
    sleep: async () => {},
  });
  assert.equal(res.status, 404);
  assert.equal(calls, 1);
});
