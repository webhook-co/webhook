// KMS_MODE / LOCAL_KEK must never be reachable from a deployed Worker.
//
// `KMS_MODE=local` swaps the AWS KEK custodian for a process-local one so a developer — or an
// external contributor, who will never have AWS credentials — can create an endpoint at all. In
// production it would seal provider secrets and ingest tokens under a throwaway key nobody custodies,
// and those rows would be permanently unopenable.
//
// The runtime fence lives in kmsProviderFromEnv (it refuses local mode whenever any AWS KMS field is
// bound). This is the second, independent fence, and it is the structural one: these keys may live
// ONLY in `.dev.vars`, which `wrangler dev` reads and `wrangler deploy` does not send.
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
export const FORBIDDEN_IN_DEPLOYED_CONFIG = ["KMS_MODE", "LOCAL_KEK"];

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
      `kms-mode-guard: expected at least 9 deployed configs, found ${configs.length} — the discovery glob is broken`,
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
      `❌ KMS_MODE/LOCAL_KEK must never reach a deployed Worker — they belong in .dev.vars only:\n` +
        violations.map((v) => `   ${v.path}: ${v.keys.join(", ")}`).join("\n") +
        `\n\n   A committed \`vars\` entry survives verbatim into production: the deploy overlay only` +
        `\n   prepends top-level keys, it does not strip vars. A local KEK in production would seal` +
        `\n   secrets under a key nobody custodies.`,
    );
    process.exit(1);
  }
  console.log("✅ no KMS_MODE/LOCAL_KEK in any deployed Worker config");
}
