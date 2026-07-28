import test from "node:test";
import assert from "node:assert/strict";

import { check, REQUIRED_POSITIVE, REQUIRED_NEGATIVE } from "./plugin-test-cases-guard.mjs";
import { FIXTURES } from "../plugin/webhook-co/testing/fixtures.mjs";

/**
 * These run the REAL guard over the REAL submission cases and the REAL engine. The point of the
 * artifact is that the cases are true, so a test suite that stubbed the engine would defeat it.
 */

const OK_CASES = {
  positive: Array.from({ length: REQUIRED_POSITIVE }, (_, i) => ({
    id: `p${i}`,
    prompt: "p",
    expectedBehaviour: "b",
    expectedResultShape: "s",
    fixtureId: "verifies-when-correct",
    expected: { ok: true },
  })),
  negative: Array.from({ length: REQUIRED_NEGATIVE }, (_, i) => ({
    id: `n${i}`,
    prompt: "p",
    expectedOutcome: "o",
    whyItShouldNotComplete: "w",
    mustAppearInSkill: "REFUSAL",
  })),
};
const sources = (o = {}) => ({
  casesSource: JSON.stringify(OK_CASES),
  skillSource: "the skill says REFUSAL somewhere",
  ...o,
});

test("the real submission cases are structurally sound and every refusal is in the real skill", () => {
  assert.deepEqual(check(), []);
});

test("every fixture carries the fields the replay needs", () => {
  // Floor: if a fixture id stopped resolving, the structural check would be covering nothing. The
  // REPLAY itself lives in packages/webhooks-spec/src/plugin-test-cases.test.ts — this script runs in
  // `lint`, which does not build, so it must never import the engine.
  assert.ok(Object.keys(FIXTURES).length >= REQUIRED_POSITIVE);
  for (const [id, f] of Object.entries(FIXTURES)) {
    for (const field of ["provider", "body", "headers", "secrets", "nowUnix"]) {
      assert.ok(f[field] !== undefined, `fixture ${id} is missing ${field}`);
    }
  }
});

test("unreadable cases fail instead of passing vacuously", () => {
  const problems = check(sources({ casesSource: null }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /cannot read/i);
});

test("an unreadable skill fails, because every refusal check would otherwise pass over nothing", () => {
  const problems = check(sources({ skillSource: null }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /cannot read/i);
});

test("the exact 5/3 counts are enforced in both directions", () => {
  const fewer = { ...OK_CASES, positive: OK_CASES.positive.slice(1) };
  const more = { ...OK_CASES, negative: [...OK_CASES.negative, OK_CASES.negative[0]] };
  for (const [cases, word] of [
    [fewer, "positive"],
    [more, "negative"],
  ]) {
    const problems = check(sources({ casesSource: JSON.stringify(cases) }));
    assert.equal(problems.length, 1);
    assert.ok(problems[0].includes(word), `should name ${word}: ${problems[0]}`);
  }
});

test("a fixtureId that resolves to nothing fails rather than being skipped", () => {
  const cases = {
    ...OK_CASES,
    positive: [
      { ...OK_CASES.positive[0], fixtureId: "no-such-fixture" },
      ...OK_CASES.positive.slice(1),
    ],
  };
  const problems = check(sources({ casesSource: JSON.stringify(cases) }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not in fixtures/);
});

test("a refusal the skill does not state fails", () => {
  const problems = check(sources({ skillSource: "this skill states nothing of the sort" }));
  assert.equal(problems.length, REQUIRED_NEGATIVE);
  assert.match(problems[0], /requires the skill to state/);
});

test("a case missing a required field fails", () => {
  const cases = { ...OK_CASES, positive: [{ id: "p0" }, ...OK_CASES.positive.slice(1)] };
  const problems = check(sources({ casesSource: JSON.stringify(cases) }));
  assert.ok(problems.length >= 1);
  assert.match(problems.join(" "), /is missing/);
});
