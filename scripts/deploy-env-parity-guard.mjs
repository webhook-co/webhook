#!/usr/bin/env node
/**
 * Guard: every variable `gen-wrangler-prod.mjs` REQUIRES is supplied by every workflow that runs it.
 *
 * WHY THIS EXISTS. The generator emits **every** app's config on **every** run, and `reqEnv()` throws
 * on a missing variable. So adding one app's resource id to only the workflow that deploys that app
 * wedges the *other* deploys — they run the same generator, hit the same `reqEnv`, and fail on an id
 * for a Worker they do not even ship.
 *
 * That is not hypothetical: it is exactly how `KV_HEALTH_ID` broke `deploy-web` and `deploy-auth`
 * while `deploy-wedge` stayed green, which is the confusing shape of the failure — the workflow you
 * changed passes and two unrelated ones fail.
 *
 * FLOOR. Fails if it cannot find the generator, its `reqEnv` calls, or the workflows that run it, so
 * a refactor that breaks discovery fails loudly instead of passing over an empty set.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATOR = "scripts/gen-wrangler-prod.mjs";
const WORKFLOWS = join(REPO, ".github", "workflows");

/** Names passed to `reqEnv("...")` in the generator — the ones that throw when absent. */
export function requiredEnvNames(source) {
  return [...source.matchAll(/reqEnv\(\s*"([A-Z0-9_]+)"\s*\)/g)].map((m) => m[1]).sort();
}

/**
 * Names read as `process.env.X` — the OPTIONAL ones. Unlike `reqEnv()`, these do not throw when absent:
 * they substitute to `""` and the feature they gate silently ships DARK, with every gate green. That is
 * the failure this half exists for. De-duplicated, since one var is usually read once but referenced from
 * several app blocks.
 */
export function optionalEnvNames(source) {
  return [
    ...new Set([...source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1])),
  ].sort();
}

/** Workflow files that invoke the generator. */
export function workflowsRunningGenerator(dir = WORKFLOWS) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .filter((f) => readFileSync(join(dir, f), "utf8").includes("gen-wrangler-prod.mjs"))
    .sort();
}

export function check({ repo = REPO, workflowsDir = WORKFLOWS, generatorSource } = {}) {
  const problems = [];
  // Injectable so the guard's own tests can exercise its logic against a controlled variable set
  // rather than against whatever the real generator happens to require today.
  const source = generatorSource ?? readFileSync(join(repo, GENERATOR), "utf8");
  const required = requiredEnvNames(source);
  const optional = optionalEnvNames(source);
  const workflows = workflowsRunningGenerator(workflowsDir);

  if (required.length < 5) {
    problems.push(
      `discovery floor: found only ${required.length} reqEnv() names in ${GENERATOR} (expected >= 5). ` +
        `Detection is broken — this guard would otherwise pass vacuously.`,
    );
  }
  if (optional.length < 5) {
    problems.push(
      `discovery floor: found only ${optional.length} optional process.env names in ${GENERATOR} ` +
        `(expected >= 5). Detection is broken — the optional-var check below would pass over an empty set.`,
    );
  }
  if (workflows.length < 2) {
    problems.push(
      `discovery floor: found only ${workflows.length} workflow(s) running the generator (expected >= 2).`,
    );
  }
  if (problems.length > 0) return problems;

  for (const wf of workflows) {
    const text = readFileSync(join(workflowsDir, wf), "utf8");
    const missing = required.filter((name) => !text.includes(name));
    if (missing.length > 0) {
      problems.push(
        `.github/workflows/${wf} runs ${GENERATOR} but does not pass: ${missing.join(", ")}. ` +
          `The generator emits EVERY app's config, so a missing id wedges THIS deploy even if the ` +
          `Worker it belongs to is deployed elsewhere.`,
      );
    }
  }

  // Optional vars need only ONE workflow — the one that deploys the Worker reading them. Demanding all of
  // them would force noise into workflows that render a config they never ship. But forwarded by NOBODY
  // means the generator substitutes "" on every path and the feature is dark everywhere, silently.
  const forwarded = new Set(
    workflows.flatMap((wf) =>
      [
        ...readFileSync(join(workflowsDir, wf), "utf8").matchAll(
          /^\s{6}([A-Z][A-Z0-9_]*):\s*\$\{\{\s*vars\./gm,
        ),
      ].map((m) => m[1]),
    ),
  );
  const dark = optional.filter((name) => !forwarded.has(name));
  if (dark.length > 0) {
    problems.push(
      `${GENERATOR} reads these optional vars but NO workflow forwards them: ${dark.join(", ")}. ` +
        `They substitute to "" on every deploy path, so the features they gate ship dark while every ` +
        `check stays green. Add each to the \`env:\` block of the workflow that deploys the Worker ` +
        `reading it.`,
    );
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = check();
  if (problems.length > 0) {
    console.error("deploy-env-parity-guard: FAILED\n");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const n = requiredEnvNames(readFileSync(join(REPO, GENERATOR), "utf8")).length;
  console.log(
    `deploy-env-parity-guard: OK (${n} required vars supplied by all ` +
      `${workflowsRunningGenerator().length} workflows that run the generator)`,
  );
}
