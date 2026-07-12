#!/usr/bin/env node
// Deploy-token PR-scope guard. Fails if any .github/workflows/deploy*.yml exposes the prod
// CLOUDFLARE_API_TOKEN to its pull_request code path. Wired into the `lint` script; its pure decision
// (deployTokenViolations / hasPullRequestTrigger) is unit-tested in scripts/deploy-token-pr-guard.test.mjs.
//
// WHY: every deploy workflow runs on BOTH `push`/`workflow_dispatch` (the real `wrangler deploy`, which needs
// the token) AND `pull_request` (only `wrangler deploy --dry-run` + gen-wrangler-prod.mjs, NEITHER of which
// authenticates — verified). GitHub already withholds secrets from FORK PRs and the jobs carry a same-repo
// `if` guard, so a fork can't reach the token. The residual this closes is a SAME-REPO PR: a job-level
// `CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}` puts the live prod deploy token in scope for
// that PR's build scripts (a compromised dependency or a malicious same-repo branch could exfiltrate it),
// even though nothing on the PR path needs it. A prod deploy credential must never be reachable by
// PR-triggered code.
//
// The fix the guard enforces: gate the token VALUE on the event so it resolves to '' on a pull_request run —
//   CLOUDFLARE_API_TOKEN: ${{ github.event_name != 'pull_request' && secrets.CLOUDFLARE_API_TOKEN || '' }}
// (empty on a PR, the real secret on push/dispatch). This is robust to how many steps read it: the token
// simply isn't present in a PR run's environment.
//
// FAIL CLOSED: a workflow that has a pull_request trigger AND assigns the raw `secrets.CLOUDFLARE_API_TOKEN`
// without the `github.event_name != 'pull_request'` gate is a violation. A push/dispatch-only workflow may
// use the bare secret freely (there is no PR path to leak it).

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = join(ROOT, ".github/workflows");

/** Human-readable form the guard requires — surfaced in the failure message and asserted by the test. */
export const SAFE_TOKEN_HINT =
  "CLOUDFLARE_API_TOKEN: ${{ github.event_name != 'pull_request' && secrets.CLOUDFLARE_API_TOKEN || '' }}";

/**
 * True when the workflow declares a `pull_request` (or the fork-secret-bearing `pull_request_target`) trigger,
 * in EITHER the block-key form (`  pull_request:`) or the flow-array form (`on: [push, pull_request]`). A prose
 * `#   pull_request -> ...` comment (whose first non-space char is `#`) is NOT a trigger. `pull_request_target`
 * is treated as a PR trigger too — it is strictly MORE dangerous (it hands secrets to fork PRs).
 * @param {unknown} text @returns {boolean}
 */
export function hasPullRequestTrigger(text) {
  if (typeof text !== "string") return false;
  // Block-key form: a line whose first non-whitespace token is `pull_request:` / `pull_request_target:`.
  if (/^[^\S\n]*pull_request(_target)?\s*:/m.test(text)) return true;
  // Flow-array form: `on: [ ... pull_request ... ]`. Scan the bracketed list for the word.
  const arr = /^[^\S\n]*on\s*:\s*\[([^\]]*)\]/m.exec(text);
  return arr ? /\bpull_request(_target)?\b/.test(arr[1]) : false;
}

/** A `CLOUDFLARE_API_TOKEN:` assignment line (key-anchored), capturing the rest of the line as its value. */
const TOKEN_LINE = /^[^\S\n]*CLOUDFLARE_API_TOKEN\s*:(.*)$/gm;
/** The secret reference we care about leaking. */
const SECRET_REF = /secrets\.CLOUDFLARE_API_TOKEN/g;
/** The value must resolve to '' on a pull_request run: `github.event_name != 'pull_request' && <secret>`. */
const SAFE_GATE = /github\.event_name\s*!=\s*'pull_request'\s*&&\s*secrets\.CLOUDFLARE_API_TOKEN/;
/** A YAML block-scalar indicator (`|`, `>`, `|-`, `>-`, `|+2`, …) — value spills onto later lines we don't
 *  parse, so we can't prove it's gated. Fail closed. */
const BLOCK_SCALAR = /^\s*[|>][+-]?\d*\s*$/;

/**
 * The pure decision: for each workflow, if it has a pull_request(_target) trigger, every assignment that pulls
 * in `secrets.CLOUDFLARE_API_TOKEN` must be event-gated to empty on a PR. FAIL CLOSED on forms we can't prove
 * safe (block scalars) or that re-expose the secret (a second, ungated reference on the same line).
 * @param {ReadonlyArray<{name: string, text: string}>} workflows @returns {string[]}
 */
export function deployTokenViolations(workflows) {
  if (!Array.isArray(workflows)) return ["could not read the deploy workflows"];
  const violations = [];
  const flag = (name, why) =>
    violations.push(
      `${name}: CLOUDFLARE_API_TOKEN reaches the pull_request path — ${why}. Gate it on the event so it is ` +
        `empty on a PR:\n      ${SAFE_TOKEN_HINT}`,
    );
  for (const wf of workflows) {
    const name = wf?.name ?? "(unknown)";
    const text = wf?.text;
    if (typeof text !== "string") {
      violations.push(`${name}: unreadable workflow (fail closed)`);
      continue;
    }
    if (!hasPullRequestTrigger(text)) continue; // no PR path ⇒ the bare secret can't leak
    for (const m of text.matchAll(TOKEN_LINE)) {
      const value = m[1];
      // A block-scalar value (`>-`, `|`, …) continues on lines this single-line scan can't see ⇒ fail closed.
      if (BLOCK_SCALAR.test(value)) {
        flag(name, "its value is a YAML block scalar the guard can't prove is event-gated");
        continue;
      }
      const refs = value.match(SECRET_REF)?.length ?? 0;
      if (refs === 0) continue; // a placeholder / empty value can't leak the secret
      // Exactly one reference AND it must be behind the `!= 'pull_request'` gate. Two references means a
      // trailing `|| secrets...` re-exposes the raw secret on the PR branch of the ternary.
      if (refs !== 1) {
        flag(
          name,
          "the secret is referenced more than once (an ungated fallback re-exposes it on a PR)",
        );
        continue;
      }
      if (!SAFE_GATE.test(value)) {
        flag(name, "the raw secrets.CLOUDFLARE_API_TOKEN is in scope for PR-triggered runs");
      }
    }
  }
  return violations;
}

async function main() {
  const files = (await readdir(WORKFLOWS)).filter((f) => /^deploy.*\.yml$/.test(f));
  const workflows = await Promise.all(
    files.map(async (name) => ({ name, text: await readFile(join(WORKFLOWS, name), "utf8") })),
  );
  const violations = deployTokenViolations(workflows);
  if (violations.length > 0) {
    console.error(
      "✖ deploy-token PR-scope: the prod CLOUDFLARE_API_TOKEN reaches a pull_request path:\n",
    );
    for (const v of violations) console.error(`  ${v}\n`);
    process.exit(1);
  }
  console.log(
    `✔ deploy-token PR-scope: all ${workflows.length} deploy workflows keep CLOUDFLARE_API_TOKEN out of the ` +
      "pull_request path.",
  );
}

// Run only when invoked directly (not when imported by the test — which would trip process.exit).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
