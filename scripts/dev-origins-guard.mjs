#!/usr/bin/env node
// Every Next app must allow `127.0.0.1` as a dev origin.
//
// `127.0.0.1:<port>` and `localhost:<port>` reach the same server, but Next treats them as different
// ORIGINS and refuses dev-asset requests from one it wasn't started on. The failure mode is what makes
// this worth a guard: nothing errors. The HTML renders, the security headers are correct, and curl gets
// a clean 200 — but the client bundle is refused, so React never hydrates. No effect runs. On the login
// page that meant the Turnstile script was never fetched and the submit button sat on "Verifying you're
// human…" indefinitely, which reads as a broken captcha rather than a host mismatch.
//
// It matters here specifically because the rest of the dev stack pins 127.0.0.1 (`wrangler dev --ip
// 127.0.0.1`, see scripts/dev-ports.mjs), so it is the natural host to type — and because a health check
// that only asserts "HTTP 200" cannot tell a hydrated page from a dead one.
//
// Run: node scripts/dev-origins-guard.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const APPS_DIR = resolve(import.meta.dirname, "..", "apps");
const REQUIRED_ORIGIN = "127.0.0.1";

/** Read a config file. Throws (loudly) rather than returning "" — a silent empty read passes every check. */
export function readConfigSource(path) {
  return readFileSync(path, "utf8");
}

/**
 * Discover every Next app by the presence of next.config.ts — never a hand-written list, which stops
 * covering the app added after it was written.
 */
function discoverNextConfigs() {
  const found = [];
  for (const app of readdirSync(APPS_DIR).sort()) {
    const path = join(APPS_DIR, app, "next.config.ts");
    try {
      if (statSync(path).isFile()) found.push({ app, path });
    } catch {
      // not a Next app — no next.config.ts
    }
  }
  return found;
}

export const NEXT_CONFIGS = discoverNextConfigs();

/** Strip comments so a note mentioning the knob can't satisfy the check. */
function stripComments(source) {
  return source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * The apps whose config does not allow {@link REQUIRED_ORIGIN} as a dev origin.
 *
 * Pure and exported: the entries can be supplied directly, so the tests can prove the check FAILS on a
 * config that lacks the allowance. A guard whose negative case is never exercised can pass by construction.
 */
export function appsMissingDevOrigin(entries) {
  const list = entries ?? NEXT_CONFIGS.map((c) => ({ ...c, source: readConfigSource(c.path) }));
  const missing = [];
  for (const { app, path, source } of list) {
    const code = stripComments(source);
    const block = /allowedDevOrigins\s*:\s*\[([^\]]*)\]/.exec(code);
    if (!block || !block[1].includes(REQUIRED_ORIGIN)) missing.push({ app, path });
  }
  return missing;
}

function run() {
  if (NEXT_CONFIGS.length === 0) {
    console.error(
      "dev-origins-guard: found no next.config.ts under apps/ — refusing to pass vacuously.",
    );
    process.exit(1);
  }
  const missing = appsMissingDevOrigin();
  if (missing.length > 0) {
    console.error(
      `\n${missing.length} Next app(s) do not allow ${REQUIRED_ORIGIN} as a dev origin:\n` +
        missing.map((m) => `  ${m.app}  (${m.path})`).join("\n") +
        `\n\nAdd \`allowedDevOrigins: ["${REQUIRED_ORIGIN}"]\` to each. Without it, browsing the app at ` +
        `http://${REQUIRED_ORIGIN}:<port> serves a page that never hydrates — a clean 200 with no working ` +
        `client JavaScript.\n`,
    );
    process.exit(1);
  }
  console.log(`✅ ${NEXT_CONFIGS.length} Next apps allow ${REQUIRED_ORIGIN} as a dev origin`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
