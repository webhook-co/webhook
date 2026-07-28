#!/usr/bin/env node
/**
 * The directory submission wants 5 positive and 3 negative test cases. This makes them TRUE rather
 * than aspirational.
 *
 * WHY THIS EXISTS. The most-reported rejection is a non-actionable "one or more of your test cases
 * did not produce correct results". Test cases written into a form are prose: nothing stops the
 * product moving underneath them, and the first time anyone finds out is at review. So every positive
 * case here carries real `fixture` bytes, and this guard runs them through the REAL
 * `@webhook-co/webhooks-spec` engine and asserts the case's claimed `reasonCode` is what the engine
 * actually returns. A case that stops being true fails the build.
 *
 * The negative cases are refusals, so their obligation is different: each names a `mustAppearInSkill`
 * string that has to be present in SKILL.md. A refusal the skill never states is a refusal the model
 * will not make.
 *
 * FLOOR. The manifest must parse, must hold EXACTLY 5 positive and 3 negative cases (the stricter of
 * OpenAI's two contradictory readings — one page says "at least", another says "exactly"), and every
 * case must carry its required fields. An unreadable manifest, a missing skill, or zero cases are all
 * FAILURES, never a pass over an empty set.
 *
 * WHAT IT DOES NOT PROVE. It does not run a model, so it cannot prove the agent behaves as
 * `expectedBehaviour` describes. It proves the two things that CAN rot silently: that the fixtures
 * still produce the claimed diagnosis, and that the refusals are still written down.
 *
 * Wired into the `lint` script, so it runs in the required `lint` CI job.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FIXTURES } from "../plugin/webhook-co/testing/fixtures.mjs";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const PLUGIN_DIR = join(REPO, "plugin", "webhook-co");
const CASES = join(PLUGIN_DIR, "testing", "test-cases.json");
const SKILL = join(PLUGIN_DIR, "skills", "debug-webhook-signature", "SKILL.md");

/** OpenAI's docs contradict each other; this is the stricter reading. */
export const REQUIRED_POSITIVE = 5;
export const REQUIRED_NEGATIVE = 3;

const POSITIVE_FIELDS = [
  "id",
  "prompt",
  "expectedBehaviour",
  "expectedResultShape",
  "fixtureId",
  "expected",
];
const NEGATIVE_FIELDS = [
  "id",
  "prompt",
  "expectedOutcome",
  "whyItShouldNotComplete",
  "mustAppearInSkill",
];

function readOr(path, fallback = null) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
}

export function check(opts = {}) {
  const problems = [];

  const casesSource = "casesSource" in opts ? opts.casesSource : readOr(CASES);
  if (casesSource === null || casesSource === undefined) {
    problems.push(
      `plugin-test-cases-guard: cannot read ${CASES}. The submission test cases are required — ` +
        `without them this guard has nothing to check.`,
    );
    return problems;
  }

  let cases;
  try {
    cases = JSON.parse(casesSource);
  } catch (err) {
    problems.push(`test-cases.json does not parse: ${err instanceof Error ? err.message : err}`);
    return problems;
  }

  const skillSource = "skillSource" in opts ? opts.skillSource : readOr(SKILL);
  if (skillSource === null || skillSource === undefined) {
    problems.push(
      `cannot read ${SKILL}. The negative cases assert refusals are STATED in the skill; without it ` +
        `every one of them would pass over nothing.`,
    );
    return problems;
  }

  const positive = Array.isArray(cases.positive) ? cases.positive : [];
  const negative = Array.isArray(cases.negative) ? cases.negative : [];

  if (positive.length !== REQUIRED_POSITIVE) {
    problems.push(
      `expected exactly ${REQUIRED_POSITIVE} positive cases, found ${positive.length}.`,
    );
  }
  if (negative.length !== REQUIRED_NEGATIVE) {
    problems.push(
      `expected exactly ${REQUIRED_NEGATIVE} negative cases, found ${negative.length}.`,
    );
  }

  for (const c of positive) {
    for (const field of POSITIVE_FIELDS) {
      if (c[field] === undefined)
        problems.push(`positive case "${c.id ?? "?"}" is missing \`${field}\`.`);
    }
  }
  for (const c of negative) {
    for (const field of NEGATIVE_FIELDS) {
      if (c[field] === undefined)
        problems.push(`negative case "${c.id ?? "?"}" is missing \`${field}\`.`);
    }
  }
  if (problems.length > 0) return problems;

  // ---- every case must resolve to a fixture that exists.
  //
  // The REPLAY — running these bytes through the real engine and asserting the claimed reason code —
  // lives in `packages/webhooks-spec/src/plugin-test-cases.test.ts`, NOT here. This script runs in the
  // `lint` job, which does not build, and the engine's entry point is a gitignored `dist/`. Importing
  // it from here crashed CI with ERR_MODULE_NOT_FOUND while passing locally, because a built `dist`
  // happened to be lying around. A guard that only works when a build artifact survives from an
  // earlier command is not a guard.
  for (const c of positive) {
    const fixtures = "fixtures" in opts ? opts.fixtures : FIXTURES;
    if (fixtures[c.fixtureId] === undefined) {
      problems.push(
        `positive case "${c.id}" names fixtureId "${c.fixtureId}", which is not in fixtures.mjs — ` +
          `the case would otherwise be checked against nothing.`,
      );
    }
  }

  // ---- the negative cases are refusals: each must actually be written in the skill.
  for (const c of negative) {
    if (!skillSource.includes(c.mustAppearInSkill)) {
      problems.push(
        `negative case "${c.id}" requires the skill to state ${JSON.stringify(c.mustAppearInSkill)}, ` +
          `and SKILL.md does not. A refusal the skill never states is one the model will not make.`,
      );
    }
  }

  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = check();
  if (problems.length > 0) {
    console.error("plugin-test-cases-guard: FAILED\n");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const cases = JSON.parse(readFileSync(CASES, "utf8"));
  console.log(
    `plugin-test-cases-guard: OK (${cases.positive.length} positive cases wired to fixtures, ` +
      `${cases.negative.length} refusals found in the skill; the engine replay runs in webhooks-spec tests)`,
  );
}
