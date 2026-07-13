import assert from "node:assert/strict";
import { test } from "node:test";

import { pickLatest } from "./check-client-versions.mjs";

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
