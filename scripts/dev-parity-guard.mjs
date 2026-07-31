#!/usr/bin/env node
// Every local-only substitute must be written down. This checks that, rather than trusting it.
//
// AGENTS.md says local dev must not deviate from production, and that where a substitute is genuinely
// unavoidable it is recorded in docs/local-parity.md with the reason. That page ends with "if you add a
// local substitute, a mode flag, or a dev-only shortcut, add it here" — a rule enforced by nothing at all,
// which is exactly how it drifted: it described apps/web's service bindings as opt-in two PRs after they
// became the default, and BILLING_MODE had never been written down in the first place.
//
// The point is not tidiness. This lane has repeatedly found that the dangerous gaps are the SILENT ones —
// a superuser DB binding that failed by permitting, a login flow that fell back to a transport production
// retired, an absent .dev.vars that merely showed fewer buttons. None of them errored. A gap that is
// written down is a known limitation; the same gap undocumented is a bug report waiting to happen, and
// several days of somebody's time.
//
// It DISCOVERS substitutes rather than listing them, so a new one is covered the moment it exists rather
// than when someone remembers this file. Two sources today:
//
//   1. **mode flags** (`*_MODE` in the secrets manifest) — each one is, by definition, a switch that makes
//      local behave unlike production.
//   2. **a Next app whose committed Worker never runs locally** — `next dev` does not run a wrangler
//      `main`, so whatever routes that Worker adds are simply absent.
//
// Run: node scripts/dev-parity-guard.mjs   (wired into `pnpm lint`)

import { readFileSync } from "node:fs";

import { APP_NAMES, specsFor as manifestSpecsFor } from "./dev-secrets-manifest.mjs";
import { DEV_APPS, devCommand } from "./dev-ports.mjs";

/** The page that has to mention every substitute. */
export const LEDGER = "docs/local-parity.md";

/**
 * Does this app's dev command leave its committed Worker unrun?
 *
 * `next dev` is not wrangler: it never loads a `main`, so a custom Worker's routes do not exist locally.
 * `apps/www` is the live case — its Worker adds the analytics write and the MTA-STS policy response, and
 * neither is reachable under the fast loop. An app on wrangler or the OpenNext preview runs its main by
 * definition, so it is not bypassed.
 */
export function workerBypassed(devCmd, wranglerMain) {
  return Boolean(wranglerMain) && devCmd.trimStart().startsWith("next dev");
}

function mainOf(app) {
  try {
    const text = readFileSync(new URL(`../apps/${app}/wrangler.jsonc`, import.meta.url), "utf8");
    return /"main"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Every local-only substitute this repo currently has, discovered from the code that defines them.
 *
 * Injectable so the discovery itself can be tested against inputs this repo does not contain — otherwise a
 * test can only confirm that a list matches the list it was copied from.
 */
export function discoverSubstitutes({
  specsFor = manifestSpecsFor,
  appNames = APP_NAMES,
  apps = DEV_APPS,
  main = mainOf,
} = {}) {
  const found = new Map();

  for (const app of appNames) {
    for (const spec of specsFor(app)) {
      if (!spec.name.endsWith("_MODE")) continue;
      found.set(spec.name, {
        id: spec.name,
        token: spec.name,
        kind: "mode-flag",
        why: `a switch that makes local behave unlike production (declared by apps/${app})`,
      });
    }
  }

  for (const app of Object.keys(apps)) {
    const declared = main(app);
    if (!workerBypassed(devCommand(app), declared)) continue;
    found.set(`apps/${app}`, {
      id: `apps/${app}`,
      // The page must name the app by path; "www" alone would match far too much prose to mean anything.
      token: `apps/${app}`,
      kind: "worker-not-run",
      why: `runs under \`next dev\`, which never loads its wrangler main (${declared}), so that Worker's routes are absent locally`,
    });
  }

  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** The substitutes the ledger fails to mention. A plain substring check — the page is prose, not data. */
export function undocumented(substitutes, docText) {
  return substitutes.filter((s) => !docText.includes(s.token)).map((s) => s.id);
}

function main_() {
  const doc = readFileSync(new URL(`../${LEDGER}`, import.meta.url), "utf8");
  const subs = discoverSubstitutes();
  const missing = undocumented(subs, doc);
  if (missing.length > 0) {
    console.error(`\n✖ ${missing.length} local substitute(s) are not recorded in ${LEDGER}:\n`);
    for (const id of missing) {
      console.error(`   ${id} — ${subs.find((s) => s.id === id).why}`);
    }
    console.error(
      `\n  A gap that is written down is a known limitation; the same gap undocumented is a bug\n` +
        `  report waiting to happen. Add it to ${LEDGER}, with the reason it cannot be avoided.\n`,
    );
    process.exit(1);
  }
  console.log(`✅ all ${subs.length} local substitutes are recorded in ${LEDGER}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main_();
}
