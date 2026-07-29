// Every app runs locally on the port the registry says, and nothing disagrees about which port that is.
//
// The failures this catches are all of the same annoying kind: they present as "it just doesn't work" with
// no error naming the cause.
//
//   - Two apps on one port. `next dev` walks upward when its port is taken, so which app ends up where
//     depends on start order. apps/web hard-codes auth at :3001; when auth lands on :3002 instead, sign-in
//     redirects to a server that isn't auth.
//   - A `dev` script whose port drifts from the registry. Same symptom, no error.
//   - INGEST_BASE_URL disagreeing with the engine's port. A locally-created endpoint hands out an ingest
//     URL pointing at nothing, and the only signal is a curl that hangs.
//   - A new app with no `dev` script at all, which is how eight Worker apps ended up unrunnable locally.
//
// It reads the registry (scripts/dev-ports.mjs) and the dev-secrets manifest and compares them to what is
// actually in each package.json — so agreement is checked, not assumed.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { APPS as SECRET_APPS } from "./dev-secrets-manifest.mjs";
import { DEV_APPS, LOCAL_INGEST_BASE_URL, NO_LOCAL_SERVER, devCommand } from "./dev-ports.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @returns {Record<string, string> | null} the app's scripts, or null when it has no package.json */
function scriptsOf(app, repo = REPO) {
  try {
    return JSON.parse(readFileSync(join(repo, "apps", app, "package.json"), "utf8")).scripts ?? {};
  } catch {
    return null;
  }
}

/** Registry apps with no `dev` script. */
export function appsMissingDevScript(repo = REPO) {
  return Object.keys(DEV_APPS)
    .filter((app) => {
      const scripts = scriptsOf(app, repo);
      return !scripts || !scripts.dev;
    })
    .sort();
}

/**
 * Registry apps whose `dev` script does not carry the assigned port.
 *
 * Compares against the port, not the whole command: a maintainer may add flags, and failing on that would
 * make the guard something to route around rather than something to satisfy.
 */
export function appsWithWrongPort(repo = REPO) {
  /** @type {{app: string, expected: number, script: string}[]} */
  const wrong = [];
  for (const [app, spec] of Object.entries(DEV_APPS)) {
    const scripts = scriptsOf(app, repo);
    const script = scripts?.dev;
    if (!script) continue; // reported by appsMissingDevScript
    if (!script.includes(String(spec.port))) wrong.push({ app, expected: spec.port, script });
  }
  return wrong;
}

/** The manifest's INGEST_BASE_URL vs the engine's port, or null when they agree. */
export function ingestBaseUrlMismatch() {
  /** @type {{app: string, value: string}[]} */
  const found = [];
  for (const [app, spec] of Object.entries(SECRET_APPS)) {
    for (const entry of spec.own ?? []) {
      if (entry.name === "INGEST_BASE_URL" && entry.scope === "local") {
        found.push({ app, value: entry.value });
      }
    }
  }
  if (found.length === 0)
    return { reason: "no local INGEST_BASE_URL in the manifest at all", found };
  const disagreeing = found.filter((f) => f.value !== LOCAL_INGEST_BASE_URL);
  if (disagreeing.length > 0)
    return { reason: `expected ${LOCAL_INGEST_BASE_URL}`, found: disagreeing };
  return null;
}

/** App directories that are in NEITHER the registry nor the explicit no-local-server list. */
export function coverageGaps(repo = REPO) {
  const known = new Set([...Object.keys(DEV_APPS), ...NO_LOCAL_SERVER]);
  return readdirSync(join(repo, "apps"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && !known.has(e.name))
    .map((e) => e.name)
    .sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = [];
  const missing = appsMissingDevScript();
  if (missing.length) {
    problems.push(
      `apps with no \`dev\` script: ${missing.join(", ")}\n` +
        missing.map((a) => `     ${a}: "dev": "${devCommand(a)}"`).join("\n"),
    );
  }
  for (const w of appsWithWrongPort()) {
    problems.push(`apps/${w.app} dev script does not use port ${w.expected}: ${w.script}`);
  }
  const ingest = ingestBaseUrlMismatch();
  if (ingest) {
    problems.push(
      `INGEST_BASE_URL disagrees with the engine's port — ${ingest.reason}. ` +
        `A locally-created endpoint would hand out a URL pointing at nothing.`,
    );
  }
  const gaps = coverageGaps();
  if (gaps.length) {
    problems.push(
      `apps in neither DEV_APPS nor NO_LOCAL_SERVER: ${gaps.join(", ")}\n` +
        `     Add a port, or declare it has no local server. "Neither" is how an app becomes unrunnable.`,
    );
  }

  if (problems.length) {
    console.error(`❌ local dev ports:\n${problems.map((p) => `   ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(
    `✅ ${Object.keys(DEV_APPS).length} apps on distinct pinned ports; INGEST_BASE_URL matches the engine`,
  );
}
