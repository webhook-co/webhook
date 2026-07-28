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

import { getAdapterForScheme } from "../packages/webhooks-spec/dist/index.js";
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

/** Run one case's fixture through the real engine and report what actually happened. */
export async function runFixture(fixture) {
  const adapter = getAdapterForScheme(fixture.provider);
  if (adapter === undefined) return { error: `no adapter for provider "${fixture.provider}"` };
  return adapter.verify({
    rawBody: new TextEncoder().encode(fixture.body),
    headers: fixture.headers,
    secrets: fixture.secrets,
    now: new Date(fixture.nowUnix * 1000),
  });
}

export async function check(opts = {}) {
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

  // ---- the part that makes the positive cases true: run them.
  for (const c of positive) {
    const fixture = ("fixtures" in opts ? opts.fixtures : FIXTURES)[c.fixtureId];
    if (fixture === undefined) {
      problems.push(
        `positive case "${c.id}" names fixtureId "${c.fixtureId}", which is not in fixtures.mjs — ` +
          `the case would otherwise be checked against nothing.`,
      );
      continue;
    }
    const result = await runFixture(fixture);
    if (result.error !== undefined) {
      problems.push(`positive case "${c.id}": ${result.error}`);
      continue;
    }
    if (result.ok !== c.expected.ok) {
      problems.push(
        `positive case "${c.id}" claims ok=${c.expected.ok} but the engine returned ok=${result.ok}. ` +
          `The fixture no longer demonstrates what the case says it does.`,
      );
      continue;
    }
    if (c.expected.reasonCode !== undefined) {
      const actual = result.ok ? null : result.reason.code;
      if (actual !== c.expected.reasonCode) {
        problems.push(
          `positive case "${c.id}" claims reason.code ${c.expected.reasonCode} but the engine ` +
            `returned ${actual}.`,
        );
      }
    }
    if (c.expected.keyId !== undefined && result.ok && result.keyId !== c.expected.keyId) {
      problems.push(
        `positive case "${c.id}" claims keyId ${c.expected.keyId} but the engine returned ${result.keyId}.`,
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
  const problems = await check();
  if (problems.length > 0) {
    console.error("plugin-test-cases-guard: FAILED\n");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const cases = JSON.parse(readFileSync(CASES, "utf8"));
  console.log(
    `plugin-test-cases-guard: OK (${cases.positive.length} positive cases replayed through the real ` +
      `engine, ${cases.negative.length} refusals found in the skill)`,
  );
}
