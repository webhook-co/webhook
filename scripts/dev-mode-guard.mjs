// The local-dev mode flags must never appear in a committed Worker config or in the deploy overlay.
//
// Each one swaps a real dependency for a hermetic local substitute so a developer — or an external
// contributor, who will never have our AWS, Google, GitHub or Resend credentials — can run the whole stack.
// Each would be a production incident:
//
//   KMS_MODE=local    swaps the AWS KEK custodian for a process-local one. In production it would seal
//                     provider secrets and ingest tokens under a throwaway key nobody custodies, and those
//                     rows would be permanently unopenable.
//   LOCAL_KEK         the throwaway key itself.
//   EMAIL_MODE=log    prints mail to the console instead of sending it. In production that writes
//                     single-use sign-in links into log storage AND silently stops every transactional
//                     email.
//   OAUTH_MODE=optional  drops social login when it is unconfigured. In production a missing OAuth secret
//                     has to fail loudly, not quietly remove the Google button.
//
// SCOPE, precisely. This guard covers what is IN THE REPO: every committed Worker config, the deploy
// overlay, and the workflows that invoke wrangler (so a committed `wrangler deploy --var KMS_MODE:local`
// IS caught). It cannot see anything that was never committed — a `wrangler secret put`, a var typed into
// the Cloudflare dashboard, or a deploy command run by hand from a laptop.
//
// Most of those are caught instead by the RUNTIME fence, one per flag — kmsProviderFromEnv for KMS_MODE /
// LOCAL_KEK (apps/engine/src/index.ts), resolveEmailMode for EMAIL_MODE (packages/shared), and
// resolveOAuthMode for OAUTH_MODE (apps/auth/src/runtime/env.ts). Each refuses its hermetic mode against
// the PRODUCTION SECRET SHAPE: a Secrets Store binding, which is what the overlay emits and what only a
// deployed Worker has.
//
// That runtime fence only bites if the relevant secret is ACTUALLY store-bound in production, which is why
// gen-wrangler-prod.mjs injecting them unconditionally is load-bearing rather than incidental: the engine's
// four AWS secrets, auth's four OAuth secrets, and RESEND_API_KEY for both auth and web are all emitted
// with no condition, so in production each fence always has something to see.
//
// The one route covered by NEITHER fence is a hand-run `wrangler deploy --var` against a Worker whose
// matching secret is a plain string rather than a store binding. Not reachable as this repo deploys, but
// stated here rather than quietly assigned to the other fence.
//
// Why a config scan and not just "don't do that": the deploy overlay (scripts/gen-wrangler-prod.mjs)
// only PREPENDS top-level keys — it does not strip `vars`. So anything committed in a wrangler.jsonc
// `vars` block survives verbatim into production. That is exactly how INGEST_BASE_URL ships the prod
// apex. A committed `KMS_MODE` would ship the same way, silently.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Keys that must never appear in a committed Worker config or the deploy overlay. */
export const FORBIDDEN_IN_DEPLOYED_CONFIG = ["KMS_MODE", "LOCAL_KEK", "EMAIL_MODE", "OAUTH_MODE"];

/**
 * Find forbidden keys in one config's text.
 *
 * Deliberately a scan of the raw text rather than a parse: the invariant is ABSENCE, and absence is
 * the one property a text scan establishes better than a parse. A parse would only see the shapes it
 * knows how to walk (`vars`, `secrets_store_secrets`, …), so a key smuggled into a block this script
 * has never heard of would read as clean. There is no legitimate reason for either string to appear
 * anywhere in a deployed config, including in a comment that a later edit might uncomment.
 *
 * @param {string} text
 * @returns {string[]} the forbidden keys present
 */
export function forbiddenKeysIn(text) {
  return FORBIDDEN_IN_DEPLOYED_CONFIG.filter((key) => text.includes(key));
}

/**
 * Every committed Worker config. Discovered, not listed — a new app must be covered automatically.
 * @returns {{path: string, text: string}[]}
 */
export function deployedConfigs(repo = REPO) {
  const appsDir = join(repo, "apps");
  /** @type {{path: string, text: string}[]} */
  const out = [];
  for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of readdirSync(join(appsDir, entry.name))) {
      // wrangler.jsonc, wrangler.bench.jsonc, … but never the gitignored generated overlay.
      if (!/^wrangler.*\.(jsonc|json|toml)$/.test(file)) continue;
      if (file.includes(".prod.")) continue;
      out.push({
        path: `apps/${entry.name}/${file}`,
        text: readFileSync(join(appsDir, entry.name, file), "utf8"),
      });
    }
  }
  // The deploy overlay itself: if it ever learned to inject these, the config scan alone would miss it.
  out.push({
    path: "scripts/gen-wrangler-prod.mjs",
    text: readFileSync(join(repo, "scripts/gen-wrangler-prod.mjs"), "utf8"),
  });
  // ...and the workflows, because `wrangler deploy --var KMS_MODE:local` is committed code that sets a
  // Worker var without touching any config file. This is the one out-of-band route that lives in the
  // repo, so it is the one this guard can and should cover.
  const wfDir = join(repo, ".github", "workflows");
  /** @type {string[]} */
  let workflows;
  try {
    workflows = readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f));
  } catch {
    workflows = []; // no workflows dir in a synthetic tree
  }
  for (const f of workflows) {
    out.push({ path: `.github/workflows/${f}`, text: readFileSync(join(wfDir, f), "utf8") });
  }
  return out;
}

/**
 * @returns {{path: string, keys: string[]}[]} violations
 */
export function findViolations(repo = REPO) {
  const configs = deployedConfigs(repo);
  // Zero-input floor: a glob that silently stops matching would make this guard pass on everything.
  // There are 12 apps, most with a wrangler config, plus the overlay.
  if (configs.length < 9) {
    throw new Error(
      `dev-mode-guard: expected at least 9 deployed configs, found ${configs.length} — the discovery glob is broken`,
    );
  }
  return configs
    .map(({ path, text }) => ({ path, keys: forbiddenKeysIn(text) }))
    .filter((v) => v.keys.length > 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let violations;
  try {
    violations = findViolations();
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
  if (violations.length) {
    console.error(
      `❌ a local-dev mode flag must not appear in a committed Worker config, the deploy overlay, or a workflow:\n` +
        violations.map((v) => `   ${v.path}: ${v.keys.join(", ")}`).join("\n") +
        `\n\n   Keep them in .dev.vars, which \`wrangler deploy\` never sends.` +
        `\n   A committed \`vars\` entry survives verbatim into production: the deploy overlay only` +
        `\n   prepends top-level keys, it does not strip vars. Each of these flags is a` +
        `\n   production incident on its own — see the header of this file.`,
    );
    process.exit(1);
  }
  console.log("✅ no local-dev mode flag in any deployed Worker config");
}
