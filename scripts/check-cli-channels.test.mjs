import assert from "node:assert/strict";
import { test } from "node:test";

import { checkChannels, compareVersions, parseFormulaVersion } from "./check-cli-channels.mjs";

const FORMULA = `
class Wbhk < Formula
  desc "…"
  version "0.3.0"
  license "Apache-2.0"
`;

test("reads the version out of a real formula", () => {
  assert.equal(parseFormulaVersion(FORMULA), "0.3.0");
});

// A parser that quietly returns null on an unrecognised formula would make this guard pass FOREVER.
test("returns null when the formula has no version — and the check treats that as a FAILURE", () => {
  assert.equal(parseFormulaVersion("class Wbhk < Formula\nend"), null);
  assert.match(checkChannels("0.3.0", null), /could not read a version/);
});

test("orders numerically, not lexicographically", () => {
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1); // as strings, "0.10.0" < "0.9.0"
  assert.equal(compareVersions("0.3.0", "0.3.0"), 0);
  assert.equal(compareVersions("0.2.0", "0.3.0"), -1);
});

test("silent when both channels agree", () => {
  assert.equal(checkChannels("0.3.0", "0.3.0"), null);
});

// The exact failure that stranded every brew user on 0.2.0 while npm served 0.3.0.
test("FAILS when npm is ahead of Homebrew — the draft-release trap", () => {
  const problem = checkChannels("0.3.0", "0.2.0");
  assert.match(problem, /npm serves 0\.3\.0 but Homebrew still serves 0\.2\.0/);
  assert.match(problem, /DRAFT/); // tells you the actual cause, not just "they differ"
  assert.match(problem, /--draft=false/); // and the exact command that fixes it
});

// Homebrew cannot lead npm through this pipeline; if it somehow does, that is not the failure we guard.
test("does not fail when Homebrew is somehow ahead", () => {
  assert.equal(checkChannels("0.2.0", "0.3.0"), null);
});
