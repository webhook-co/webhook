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
import {
  DEV_APPS,
  LOCAL_INGEST_BASE_URL,
  NO_LOCAL_SERVER,
  devCommand,
  duplicateAssignments,
  inspectorPortFor,
} from "./dev-ports.mjs";

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

/**
 * Wrangler-backed apps whose `dev` script does not pin their inspector port.
 *
 * Checked separately from the HTTP port because the symptom is different and worse: an unpinned inspector
 * port is not "this app is on the wrong port", it is "every Worker after the first refuses to start".
 */
export function appsWithWrongInspectorPort(repo = REPO) {
  /** @type {{app: string, expected: number, script: string}[]} */
  const wrong = [];
  for (const app of Object.keys(DEV_APPS)) {
    const expected = inspectorPortFor(app);
    if (expected === null) continue; // next dev opens no inspector
    const script = scriptsOf(app, repo)?.dev;
    if (!script) continue; // reported by appsMissingDevScript
    // Tokenised and compared for EQUALITY rather than substring-matched: `includes("9787")` would also be
    // satisfied by `19787`, and a port guard that accepts a near-miss is the bug it is meant to catch.
    const tokens = script.split(/[\s=]+/);
    const at = tokens.indexOf("--inspector-port");
    if (at < 0 || tokens[at + 1] !== String(expected)) wrong.push({ app, expected, script });
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

// ── `pnpm dev` must have a slot for every app ───────────────────────────────────────────────────────────
//
// turbo does not queue persistent tasks: given more of them than it has concurrency slots it exits 1
// BEFORE starting anything, with "You have N persistent tasks but `turbo` is configured for concurrency of
// M". So this is not a performance knob — below the threshold, `pnpm dev` starts nothing at all.
//
// That is exactly how it broke. Giving the eight Worker apps their `dev` scripts took the repo from 3
// persistent tasks to 11 and crossed turbo's default of 10, so the single command this lane exists to
// deliver failed instantly, and no test noticed because nothing ran `pnpm dev`.

/** turbo's concurrency when nothing configures it. */
export const TURBO_DEFAULT_CONCURRENCY = 10;

/** @returns {Record<string, string>} the ROOT package.json scripts. */
function rootScripts(repo = REPO) {
  return JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts ?? {};
}

/**
 * How many persistent `dev` tasks `pnpm dev` will start.
 *
 * Counted from the registry ∩ what each package.json actually declares, so it tracks reality rather than
 * a number someone has to remember to bump.
 */
export function persistentDevTaskCount(repo = REPO) {
  return Object.keys(DEV_APPS).filter((app) => scriptsOf(app, repo)?.dev).length;
}

/**
 * Is `configured` enough concurrency for `persistent` persistent tasks?
 *
 * turbo's own error names the rule — 11 tasks require "at least 12" — so N tasks need N+1: turbo keeps one
 * slot free for non-persistent work. Pass `configured: null` for a value that cannot be statically compared
 * (a percentage), which is treated as insufficient rather than assumed fine.
 *
 * Pure and exported so that weakening it IS a test failure.
 *
 * @returns {{persistent: number, configured: number|null, needed: number} | null} null when sufficient.
 */
export function concurrencyShortfall(persistent, configured) {
  const needed = persistent + 1;
  if (configured !== null && configured >= needed) return null;
  return { persistent, configured, needed };
}

/**
 * The concurrency `pnpm dev` will really run with, and where it came from.
 *
 * Both sources are consulted because either would work and a guard that reads only one would fire falsely
 * on the other. A percentage resolves against the machine's core count, so it yields `value: null` — it
 * cannot be shown sufficient on every machine, and a dev box with few cores is precisely where this bites.
 *
 * @returns {{value: number|null, source: string}}
 */
export function effectiveDevConcurrency(repo = REPO) {
  const flag = (rootScripts(repo).dev ?? "").match(/--concurrency[= ](\d+%?)/);
  if (flag) {
    const raw = flag[1];
    return raw.endsWith("%")
      ? { value: null, source: `--concurrency=${raw} in the root dev script` }
      : { value: Number(raw), source: "the root dev script" };
  }
  const configured = JSON.parse(readFileSync(join(repo, "turbo.json"), "utf8")).concurrency;
  if (configured !== undefined) {
    const n = typeof configured === "number" ? configured : Number(String(configured).trim());
    return Number.isInteger(n) && n > 0
      ? { value: n, source: "turbo.json" }
      : { value: null, source: `turbo.json concurrency ${JSON.stringify(configured)}` };
  }
  return { value: TURBO_DEFAULT_CONCURRENCY, source: "turbo default" };
}

/** The shortfall that would stop `pnpm dev` starting, or null when there is none. */
export function devConcurrencyShortfall(repo = REPO) {
  return concurrencyShortfall(persistentDevTaskCount(repo), effectiveDevConcurrency(repo).value);
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
  for (const w of appsWithWrongInspectorPort()) {
    problems.push(
      `apps/${w.app} dev script does not pin --inspector-port ${w.expected}: ${w.script}\n` +
        `     Every wrangler dev defaults its inspector to 9229, so unpinned means only the FIRST Worker starts.`,
    );
  }
  for (const d of duplicateAssignments()) {
    problems.push(`port ${d.port} is claimed by more than one binding: ${d.holders.join(", ")}`);
  }
  const ingest = ingestBaseUrlMismatch();
  if (ingest) {
    problems.push(
      `INGEST_BASE_URL disagrees with the engine's port — ${ingest.reason}. ` +
        `A locally-created endpoint would hand out a URL pointing at nothing.`,
    );
  }
  const short = devConcurrencyShortfall();
  if (short) {
    const { source } = effectiveDevConcurrency();
    problems.push(
      `\`pnpm dev\` cannot start every app: ${short.persistent} persistent dev tasks, but concurrency is ` +
        `${short.configured ?? "a percentage"} (from ${source}) — turbo needs at least ${short.needed}.\n` +
        `     turbo exits BEFORE starting anything, so this is not a slow \`pnpm dev\`, it is no \`pnpm dev\`.\n` +
        `     Fix: set --concurrency=${short.needed} (or higher) on the root \`dev\` script.`,
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
