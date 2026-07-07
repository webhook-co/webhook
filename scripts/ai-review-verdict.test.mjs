import assert from "node:assert/strict";
import { test } from "node:test";

import { parseVerdict } from "./ai-review-verdict.mjs";

test("missing/empty output → null (incomplete)", () => {
  assert.equal(parseVerdict(""), null);
  assert.equal(parseVerdict("   \n  \n"), null);
});

test("non-string input → null", () => {
  assert.equal(parseVerdict(undefined), null);
  assert.equal(parseVerdict(null), null);
  assert.equal(parseVerdict(42), null);
});

test("review text with no VERDICT line → null (incomplete)", () => {
  assert.equal(parseVerdict("## Review\n\nLooks fine to me."), null);
});

test("ends with VERDICT: PASS → PASS", () => {
  assert.equal(parseVerdict("## Review\nNo blocking issues.\n\nVERDICT: PASS"), "PASS");
});

test("ends with VERDICT: BLOCK → BLOCK", () => {
  assert.equal(parseVerdict("## Review\n- secret leaked\n\nVERDICT: BLOCK"), "BLOCK");
});

test("last verdict wins when several appear", () => {
  assert.equal(parseVerdict("VERDICT: BLOCK\n...reconsidered...\nVERDICT: PASS"), "PASS");
});

test("trailing blank lines/whitespace after the verdict are ignored", () => {
  assert.equal(parseVerdict("VERDICT: PASS\n\n   \n"), "PASS");
});

test("case-insensitive verdict keyword and value", () => {
  assert.equal(parseVerdict("verdict: pass"), "PASS");
  assert.equal(parseVerdict("Verdict: Block"), "BLOCK");
});

test("verdict with trailing prose on the same line → null (not the exact contract)", () => {
  assert.equal(parseVerdict("VERDICT: BLOCK — see items above"), null);
});

test("a VERDICT line that is not the last non-empty line → null", () => {
  assert.equal(parseVerdict("VERDICT: PASS\n\nActually, one more note about tests."), null);
});

test("unknown verdict value → null", () => {
  assert.equal(parseVerdict("VERDICT: MAYBE"), null);
});
