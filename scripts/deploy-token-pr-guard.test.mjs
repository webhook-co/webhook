// Tests for scripts/deploy-token-pr-guard.mjs — the guard that keeps the prod CLOUDFLARE_API_TOKEN out of
// the pull_request code path of every deploy workflow. Drives the REAL exported decision (deployTokenViolations
// / hasPullRequestTrigger — exactly what main() calls) plus a live assertion over the actual shipped
// .github/workflows/deploy*.yml, so a real regression is a red build, not just a fixture that agrees with itself.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  deployTokenViolations,
  hasPullRequestTrigger,
  SAFE_TOKEN_HINT,
} from "./deploy-token-pr-guard.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = join(ROOT, ".github/workflows");

/** The canonical safe assignment: the secret resolves to '' on a pull_request run, real otherwise. */
const SAFE = `      CLOUDFLARE_API_TOKEN: \${{ github.event_name != 'pull_request' && secrets.CLOUDFLARE_API_TOKEN || '' }}`;
/** The unsafe assignment: the raw secret is in scope for every trigger, pull_request included. */
const BARE = `      CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}`;

const PR_ON = `on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
`;
const PUSH_ONLY_ON = `on:
  push:
    branches: [main]
`;

test("hasPullRequestTrigger: true for a real pull_request trigger key, false for push-only", () => {
  assert.equal(hasPullRequestTrigger(PR_ON), true);
  assert.equal(hasPullRequestTrigger(PUSH_ONLY_ON), false);
});

test("hasPullRequestTrigger: a prose mention of pull_request in a comment is NOT a trigger", () => {
  const commentOnly = `# on pull_request we only dry-run\n${PUSH_ONLY_ON}`;
  assert.equal(hasPullRequestTrigger(commentOnly), false);
});

test("flags a bare secret on a PR-triggered workflow", () => {
  const v = deployTokenViolations([{ name: "deploy.yml", text: `${PR_ON}jobs:\n${BARE}\n` }]);
  assert.equal(v.length, 1);
  assert.match(v[0], /deploy\.yml/);
  assert.match(v[0], /pull_request/);
});

test("passes when the token is event-gated to empty on the PR path", () => {
  const v = deployTokenViolations([{ name: "deploy.yml", text: `${PR_ON}jobs:\n${SAFE}\n` }]);
  assert.deepEqual(v, []);
});

test("a bare secret is fine when the workflow has NO pull_request trigger (push/dispatch only)", () => {
  const v = deployTokenViolations([
    { name: "deploy.yml", text: `${PUSH_ONLY_ON}jobs:\n${BARE}\n` },
  ]);
  assert.deepEqual(v, []);
});

test("catches the BACKWARDS gate that exposes the secret ON pull_request", () => {
  const backwards = `      CLOUDFLARE_API_TOKEN: \${{ github.event_name == 'pull_request' && secrets.CLOUDFLARE_API_TOKEN || '' }}`;
  const v = deployTokenViolations([{ name: "deploy.yml", text: `${PR_ON}jobs:\n${backwards}\n` }]);
  assert.equal(v.length, 1);
});

test("a commented-out token line is ignored (not a real assignment)", () => {
  const commented = `      # CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}`;
  const v = deployTokenViolations([
    { name: "deploy.yml", text: `${PR_ON}jobs:\n${commented}\n${SAFE}\n` },
  ]);
  assert.deepEqual(v, []);
});

test("SAFE_TOKEN_HINT names the pull_request gate so the failure message is actionable", () => {
  assert.match(SAFE_TOKEN_HINT, /pull_request/);
});

// --- adversarial evasions (from the security review): forms that expose the secret on PR yet a naive
// substring/single-line guard would wave through. Each MUST be flagged. ---

test("catches a DOUBLE reference — safe gate present but a trailing `|| secrets...` re-exposes on PR", () => {
  const evil = `      CLOUDFLARE_API_TOKEN: \${{ github.event_name != 'pull_request' && secrets.CLOUDFLARE_API_TOKEN || secrets.CLOUDFLARE_API_TOKEN }}`;
  const v = deployTokenViolations([{ name: "deploy.yml", text: `${PR_ON}jobs:\n${evil}\n` }]);
  assert.equal(v.length, 1);
});

test("hasPullRequestTrigger: true for the FLOW-ARRAY form `on: [push, pull_request]`", () => {
  assert.equal(hasPullRequestTrigger("on: [push, pull_request]\njobs:\n"), true);
});

test("catches a bare secret when the trigger is the flow-array `on: [push, pull_request]`", () => {
  const v = deployTokenViolations([
    { name: "deploy.yml", text: `on: [push, pull_request]\njobs:\n${BARE}\n` },
  ]);
  assert.equal(v.length, 1);
});

test("hasPullRequestTrigger: true for `pull_request_target` (fork PRs receive secrets — MORE dangerous)", () => {
  assert.equal(hasPullRequestTrigger("on:\n  pull_request_target:\n"), true);
  assert.equal(hasPullRequestTrigger("on: [pull_request_target]\n"), true);
});

test("catches a bare secret under a `pull_request_target` trigger", () => {
  const targetOn = "on:\n  pull_request_target:\n    branches: [main]\n";
  const v = deployTokenViolations([{ name: "deploy.yml", text: `${targetOn}jobs:\n${BARE}\n` }]);
  assert.equal(v.length, 1);
});

test("fails closed on a block-scalar token value it cannot analyze single-line", () => {
  const block = `      CLOUDFLARE_API_TOKEN: >-\n        \${{ secrets.CLOUDFLARE_API_TOKEN }}`;
  const v = deployTokenViolations([{ name: "deploy.yml", text: `${PR_ON}jobs:\n${block}\n` }]);
  assert.equal(v.length, 1);
});

// The load-bearing test: the ACTUAL shipped deploy workflows must all satisfy the invariant. This is the
// artifact the guard protects — if any deploy*.yml exposes the token to its PR path, this fails.
test("every shipped .github/workflows/deploy*.yml keeps the prod token out of the PR path", async () => {
  const files = (await readdir(WORKFLOWS)).filter((f) => /^deploy.*\.yml$/.test(f));
  assert.ok(files.length >= 6, `expected the deploy workflows, found ${files.length}`);
  const workflows = await Promise.all(
    files.map(async (name) => ({ name, text: await readFile(join(WORKFLOWS, name), "utf8") })),
  );
  assert.deepEqual(deployTokenViolations(workflows), []);
});
