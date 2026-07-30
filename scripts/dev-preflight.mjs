#!/usr/bin/env node
// Refuse to start `pnpm dev` with a local stack that is quietly LESS than production.
//
// The bug this exists for: a clone with no `apps/auth/.dev.vars` starts cleanly, serves a login page
// that renders perfectly, and simply offers fewer ways in — because the page derives its social buttons
// from which OAuth secrets are PRESENT (`configuredSocialProviders`). Nothing throws, nothing warns, and
// `pnpm dev` reports every app ready. You only notice if you happen to know what production looks like.
//
// That is precisely the failure mode the manifest's fence pattern is meant to forbid: "flags are
// EXPLICIT, never inferred from a missing secret". The page was inferring. This check restores the rule
// at the point it can still be acted on — before anything boots.
//
// The contract:
//   - every app the manifest declares must HAVE a .dev.vars
//   - every `generated` / `local` secret must be present and non-blank
//   - every `parityRequired` secret must be present and non-blank, UNLESS its `relaxedBy` flag is set
//
// The flag is the acknowledgement. An external contributor with no credentials sets `OAUTH_MODE=optional`
// and is waved through; everyone else gets a hard failure naming exactly what is missing. The difference
// that matters is between CHOOSING a degraded local stack and not noticing you have one.
//
// This never prints a secret VALUE — only names, and whether each is set.
//
// Run: node scripts/dev-preflight.mjs   (wired into the root `dev` script)

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { APP_NAMES, specsFor } from "./dev-secrets-manifest.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");

/** Apps that need a .dev.vars, discovered from the manifest rather than hand-listed. */
export const APPS_NEEDING_SECRETS = Object.freeze([...APP_NAMES]);

/**
 * Parse a .dev.vars into name → value.
 *
 * Splits on the FIRST `=` only: base64 secrets carry `=` padding and URLs carry query strings, and
 * splitting on every `=` would silently truncate both into something that looks set but is wrong.
 */
export function parseDevVars(source) {
  const vars = new Map();
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at < 0) continue;
    const name = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if (value.length >= 2 && /^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);
    vars.set(name, value);
  }
  return vars;
}

/** The specs an app must satisfy: everything except optional third-party extras. */
export function requiredSpecs(app) {
  return specsFor(app).filter((s) => s.scope !== "external" || s.parityRequired === true);
}

/** True when this secret's declared opt-out flag is set to its declared value. */
export function isRelaxed(spec, vars) {
  if (!spec.relaxedBy) return false;
  const actual = vars.get(spec.relaxedBy.name);
  if (actual === undefined) return false;
  return actual.trim().toLowerCase() === spec.relaxedBy.value.toLowerCase();
}

/**
 * The problems across every app.
 *
 * Takes its entries so the tests can drive it directly — a check whose failing path is never exercised
 * can pass by construction, and this one's whole job is to fail.
 *
 * @param {{app: string, exists: boolean, source: string}[]} entries
 */
export function findings(entries) {
  const out = [];
  for (const { app, exists, source } of entries) {
    if (!exists) {
      out.push({ app, kind: "missing-file", path: `apps/${app}/.dev.vars` });
      continue;
    }
    const vars = parseDevVars(source);
    const missing = [];
    for (const spec of requiredSpecs(app)) {
      if (isRelaxed(spec, vars)) continue;
      const value = vars.get(spec.name);
      if (value === undefined || value === "") missing.push(spec.name);
    }
    if (missing.length > 0) out.push({ app, kind: "missing-values", missing });
  }
  return out;
}

/** Read each app's .dev.vars from disk. A read failure means "absent", which is the point. */
function readEntries() {
  return APPS_NEEDING_SECRETS.map((app) => {
    const path = join(REPO_ROOT, "apps", app, ".dev.vars");
    try {
      return { app, exists: true, source: readFileSync(path, "utf8") };
    } catch {
      return { app, exists: false, source: "" };
    }
  });
}

/** The opt-out flags relevant to a set of missing names, so the message can offer the real escape. */
function escapesFor(app, missing) {
  const escapes = new Map();
  for (const spec of requiredSpecs(app)) {
    if (!spec.relaxedBy || !missing.includes(spec.name)) continue;
    escapes.set(`${spec.relaxedBy.name}=${spec.relaxedBy.value}`, true);
  }
  return [...escapes.keys()];
}

function run() {
  if (APPS_NEEDING_SECRETS.length === 0) {
    console.error("dev-preflight: the manifest declares no apps — refusing to pass vacuously.");
    process.exit(1);
  }

  const problems = findings(readEntries());
  if (problems.length === 0) {
    console.log(`✅ local secrets present for ${APPS_NEEDING_SECRETS.length} apps — starting dev`);
    return;
  }

  console.error("\n✖ Local dev is not at parity with production. Refusing to start.\n");
  console.error(
    "  Starting anyway would give you a stack that looks fine and quietly does less — the login\n" +
      "  page, for one, simply drops the sign-in buttons whose credentials are absent.\n",
  );

  for (const p of problems) {
    if (p.kind === "missing-file") {
      console.error(`  ${p.app}: no ${p.path}`);
      continue;
    }
    console.error(`  ${p.app}: ${p.missing.length} value(s) missing or blank`);
    for (const name of p.missing) console.error(`      ${name}`);
    const escapes = escapesFor(p.app, p.missing);
    if (escapes.length > 0) {
      console.error(
        `      (no credentials? set ${escapes.join(" or ")} to accept a degraded stack)`,
      );
    }
  }

  console.error(
    "\n  Fix: run `pnpm dev:secrets` to write a template listing every value and why it exists,\n" +
      "  then fill it in. Team credentials are in the shared store — ask rather than inventing a\n" +
      "  substitute (AGENTS.md). See docs/local-parity.md.\n",
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
