#!/usr/bin/env node
/**
 * Guard: every customer-facing Worker exposes a `/readyz` readiness probe.
 *
 * WHY THIS EXISTS. `status.webhook.co` publishes one component per service, and each component is
 * only as truthful as the endpoint behind it. A new app can ship, get a public hostname, and appear
 * healthy simply because nothing is watching it. This guard makes that impossible to do silently:
 * an app is either required to have `/readyz`, or explicitly exempted WITH A REASON.
 *
 * WHAT IT DOES AND DOES NOT PROVE. This is a REACHABILITY guard, not a correctness one. It proves a
 * `/readyz` route exists in an app's source; it does not prove the route checks the right
 * dependencies or fails when it should. That is what the per-app test suites do (see
 * `apps/engine/test/readiness.test.ts` and the `/readyz` cases in each app's router tests). Keeping
 * the two separate is deliberate — a guard that claimed to prove correctness by scanning text would
 * be a lie that reads as safety.
 *
 * FLOOR. The guard fails if it discovers implausibly few apps, so that a refactor which breaks
 * discovery fails loudly rather than passing vacuously over an empty set.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const APPS_DIR = join(REPO, "apps");

/** Apps that serve a customer-facing component on status.webhook.co and MUST have /readyz. */
export const REQUIRES_READYZ = ["api", "auth", "engine", "mcp", "web"];

/**
 * Apps deliberately without `/readyz`, each with the reason. An exemption is where scrutiny goes to
 * die, so every entry has to say WHY — "it has no dependencies to be ready for" is a real reason,
 * "we didn't get to it" is not.
 */
export const EXEMPT = {
  dmarc: "internal DMARC report processor; no customer-facing surface to report on",
  get: "static install-script host; no backend dependency, monitored by GET /",
  play: "ephemeral playground; stateless per session, monitored by its own /healthz",
  telemetry: "internal telemetry ingest; not a published status component",
  www: "static marketing site; no backend dependency, monitored by GET /",
  docs: "third-party (Mintlify); not deployed from this repo",
};

/** The smallest app count that could possibly be correct — below this, discovery itself is broken. */
const DISCOVERY_FLOOR = 8;

/** Every directory under apps/ that is actually an app (has a package.json). */
export function discoverApps(appsDir = APPS_DIR) {
  return readdirSync(appsDir)
    .filter((name) => {
      const dir = join(appsDir, name);
      return statSync(dir).isDirectory() && existsSync(join(dir, "package.json"));
    })
    .sort();
}

/**
 * Does this app route `/readyz`?
 *
 * Deliberately a source scan over the app's own `src/`, matched against the route literal. A parse
 * would be no stronger here — the route is a string compared inside a handler, not a declarative
 * config — and the per-app tests already prove the behaviour.
 */
export function hasReadyzRoute(appDir) {
  const src = join(appDir, "src");
  if (!existsSync(src)) return false;
  const stack = [src];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") stack.push(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name) || entry.name.includes(".test.")) continue;
      // A Next.js route handler is addressed by its PATH, not by a literal in the file.
      if (full.endsWith(join("app", "readyz", "route.ts"))) return true;
      if (readFileSync(full, "utf8").includes('"/readyz"')) return true;
    }
  }
  return false;
}

/** Returns a list of human-readable violations; empty means the guard passes. */
export function check({ appsDir = APPS_DIR, requires = REQUIRES_READYZ, exempt = EXEMPT } = {}) {
  const problems = [];
  const apps = discoverApps(appsDir);

  if (apps.length < DISCOVERY_FLOOR) {
    problems.push(
      `discovery floor: found only ${apps.length} apps under ${appsDir} (expected >= ${DISCOVERY_FLOOR}). ` +
        `App discovery is broken — this guard would otherwise pass over an empty set.`,
    );
    return problems;
  }

  for (const app of apps) {
    const classified = requires.includes(app) || Object.hasOwn(exempt, app);
    if (!classified) {
      problems.push(
        `apps/${app} is neither required to expose /readyz nor exempt. Add it to REQUIRES_READYZ ` +
          `and give it a /readyz route, or add it to EXEMPT with the reason it needs none.`,
      );
    }
  }

  for (const app of requires) {
    if (!apps.includes(app)) {
      problems.push(`REQUIRES_READYZ lists apps/${app}, which does not exist. Remove it.`);
      continue;
    }
    if (!hasReadyzRoute(join(appsDir, app))) {
      problems.push(
        `apps/${app} is a customer-facing component but exposes no /readyz route. Its status-page ` +
          `component would be unmonitorable.`,
      );
    }
  }

  for (const app of Object.keys(exempt)) {
    if (!apps.includes(app)) continue;
    if (requires.includes(app)) {
      problems.push(`apps/${app} is both required and exempt. Decide which.`);
    }
    if (!exempt[app] || exempt[app].length < 20) {
      problems.push(`apps/${app} is exempt without a substantive reason.`);
    }
  }

  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = check();
  if (problems.length > 0) {
    console.error("readyz-coverage-guard: FAILED\n");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    `readyz-coverage-guard: OK (${REQUIRES_READYZ.length} components expose /readyz, ` +
      `${Object.keys(EXEMPT).length} apps exempt with reasons)`,
  );
}
