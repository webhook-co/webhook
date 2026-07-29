// Every deploy-time placeholder in a committed `vars` block must have a local override.
//
// THE BUG THIS EXISTS TO PREVENT, which shipped and went unnoticed:
//
// The committed wrangler configs carry deploy-time templates — `"FREE_EVENT_CAP": "<FREE_EVENT_CAP>"` — that
// scripts/gen-wrangler-prod.mjs substitutes from a GitHub repo variable at deploy. In PRODUCTION that works.
// In LOCAL DEV nothing substitutes them, so the Worker reads the literal string `<FREE_EVENT_CAP>` — and
// every parser we have fail-safes a value it does not understand:
//
//   parseFreeEventCap("<FREE_EVENT_CAP>")  -> null   (no cap at all)
//   parseBillingMode("<BILLING_MODE>")     -> "off"  (Stripe entirely disabled)
//   ORPHAN_SWEEP_DELETE === "true"         -> false  (count-only)
//   ASYNC_ORG_DELETION  === "true"         -> false  (the sync path)
//
// Fail-safe is the RIGHT call in production — a typo must never over-charge or over-delete. But it means a
// placeholder is INDISTINGUISHABLE FROM UNSET, so locally these features are silently off and nobody can
// tell. You cannot test the free-tier cap, the billing flow, the orphan sweep, or async org deletion on your
// own machine, and nothing anywhere says so.
//
// So: if a committed `vars` value is still a placeholder, the dev-secrets manifest MUST define a local value
// for it. Then `pnpm dev:secrets` writes it into .dev.vars, which wrangler prefers over `vars`, and local
// behaviour matches production.
//
// SCOPE. Only `vars` — deliberately. Placeholders also appear in binding `id` fields
// (`<HYPERDRIVE_TENANT_ID>`, `<KV_CONFIG_ID>`), and those are NOT flags: locally Miniflare uses its own
// resources and never reads the id. Flagging them would be noise, and a guard people learn to ignore is
// worse than no guard. That distinction is exactly why this PARSES the config instead of scanning its text —
// a text scan cannot tell a `vars` value from a binding id.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseJsonc } from "jsonc-parser";

import { APPS } from "./dev-secrets-manifest.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A value that is ENTIRELY an unsubstituted deploy placeholder, e.g. `<FREE_EVENT_CAP>`. */
export const UNSUBSTITUTED = /^<[A-Z0-9_]+>$/;

/**
 * The `vars` keys in one config whose value is still a placeholder.
 * Throws on a malformed config — a partial parse that returns [] is how a guard silently stops checking.
 * @param {string} text
 * @returns {string[]}
 */
export function placeholderVarsIn(text) {
  /** @type {import("jsonc-parser").ParseError[]} */
  const errors = [];
  const config = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || config === undefined) {
    throw new Error(
      `dev-flag-parity-guard: could not parse config (${errors.length} parse error(s))`,
    );
  }
  const vars = config.vars;
  if (!vars || typeof vars !== "object") return [];
  return Object.entries(vars)
    .filter(([, value]) => typeof value === "string" && UNSUBSTITUTED.test(value))
    .map(([key]) => key)
    .sort();
}

/**
 * Placeholder `vars` per app, discovered rather than listed so a new app is covered automatically.
 * @returns {Record<string, string[]>}
 */
export function placeholderVarsByApp(repo = REPO) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const entry of readdirSync(join(repo, "apps"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const appDir = join(repo, "apps", entry.name);
    for (const file of readdirSync(appDir)) {
      if (!/^wrangler.*\.(jsonc|json)$/.test(file)) continue;
      if (file.includes(".prod.")) continue; // gitignored generated output, not a source
      const found = placeholderVarsIn(readFileSync(join(appDir, file), "utf8"));
      if (found.length === 0) continue;
      out[entry.name] = [...new Set([...(out[entry.name] ?? []), ...found])].sort();
    }
  }
  return out;
}

/** The var names the dev-secrets manifest defines for each app. */
function manifestNamesByApp() {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [app, spec] of Object.entries(APPS)) {
    out[app] = [...(spec.own ?? []).map((s) => s.name), ...(spec.shared ?? [])];
  }
  return out;
}

/**
 * Placeholder vars with no local override.
 * @returns {{app: string, name: string}[]}
 */
export function findMissingLocalOverrides(repo = REPO, manifest = manifestNamesByApp()) {
  const byApp = placeholderVarsByApp(repo);
  /** @type {{app: string, name: string}[]} */
  const missing = [];
  for (const [app, names] of Object.entries(byApp)) {
    const known = new Set(manifest[app] ?? []);
    for (const name of names) {
      if (!known.has(name)) missing.push({ app, name });
    }
  }
  return missing.sort((a, b) => a.app.localeCompare(b.app) || a.name.localeCompare(b.name));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let missing;
  try {
    missing = findMissingLocalOverrides();
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
  if (missing.length) {
    console.error(
      `❌ these committed \`vars\` are deploy-time placeholders with no local override:\n` +
        missing.map((m) => `   apps/${m.app}: ${m.name}`).join("\n") +
        `\n\n   Locally nothing substitutes them, so the Worker reads the literal "<NAME>" — and every` +
        `\n   parser fail-safes an unrecognised value, which makes a placeholder indistinguishable from` +
        `\n   unset. The feature is then silently OFF on every developer's machine.` +
        `\n\n   Add a "local" entry for it in scripts/dev-secrets-manifest.mjs, then run \`pnpm dev:secrets\`.`,
    );
    process.exit(1);
  }
  const count = Object.values(placeholderVarsByApp()).flat().length;
  console.log(`✅ all ${count} deploy-time placeholder var(s) have a local override`);
}
