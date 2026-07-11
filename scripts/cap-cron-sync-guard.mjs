#!/usr/bin/env node
// Engine cron config-sync guard. Fails if apps/engine/wrangler.jsonc `triggers.crons` is not EXACTLY the
// set of cron expressions apps/engine/src/index.ts scheduled() knows how to route — the two exported
// constants CAP_PRODUCER_CRON (the `*/5` soft-cap fast path) and HOURLY_CRON (the heavy jobs). Wired into
// the `lint` script; its pure brain is unit-tested in scripts/cap-cron-sync-guard.test.mjs.
//
// WHY (S4): Cloudflare dispatches each `triggers.crons` entry as its own scheduled() invocation, routed by
// `controller.cron`. The coupling between the wrangler triggers and the constants in index.ts is otherwise
// convention-only, and both drift directions are dangerous:
//   - a cap trigger DROPPED/MISTYPED in wrangler ⇒ the `*/5` fast path silently vanishes; the cap is then
//     enforced only by the hourly backstop, so "capture pauses within minutes" becomes false (pause latency
//     regresses to ~1h) with no error.
//   - a cron ADDED/RENAMED in wrangler that index.ts doesn't name ⇒ it falls into the hourly-backstop
//     branch of scheduledCronPlan and runs the HEAVY jobs (rollup/reconcilers/purges) on an unexpected,
//     possibly frequent cadence (e.g. a `*/1` trigger ⇒ 60× the load, racing the hourly pass).
// This guard makes either drift a red build rather than a silent prod regression.
//
// The pure decision (checkCronSync / cronSyncViolations) is exported and tested; the IO (read the two files,
// print, exit) lives in main() below. FAIL CLOSED: if a constant or the crons array can't be read, that is
// itself a violation — we can't prove the config is in sync, so we block.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = join(ROOT, "apps/engine/src/index.ts");
const WRANGLER = join(ROOT, "apps/engine/wrangler.jsonc");

/** Normalise a cron expression the SAME way scheduledCronPlan does, so a reformatted trigger still matches.
 *  @param {string} s @returns {string} */
const normalise = (s) => s.trim().replace(/\s+/g, " ");

/**
 * Extract a `export const NAME = "literal";` string value from TypeScript source. Returns the raw literal,
 * or null if the constant is absent or not a plain double-quoted string literal (⇒ fail closed upstream).
 * @param {unknown} src @param {string} name @returns {string | null}
 */
export function extractCronConst(src, name) {
  if (typeof src !== "string" || typeof name !== "string") return null;
  // A STATIC regex over every `export const NAME = "literal"` (avoids a computed RegExp), then match by
  // name — so a constant assigned a non-string (e.g. `= someVar`) yields no capture ⇒ null (fail closed).
  for (const m of src.matchAll(/export const (\w+)\s*=\s*"([^"]*)"/g)) {
    if (m[1] === name) return m[2];
  }
  return null;
}

/**
 * Extract the `triggers.crons` array from wrangler.jsonc TEXT. Targets JUST the array literal (up to the
 * first `]`) rather than parsing the whole JSONC file, so arbitrary `//` comments elsewhere in the file
 * can't break it. Strips inline `//` comments + a trailing comma inside the captured array (cron strings
 * contain no `//` and no `]`, so this is safe). Returns the string[] or null if absent/unparseable.
 * @param {unknown} text @returns {string[] | null}
 */
export function readWranglerCrons(text) {
  if (typeof text !== "string") return null;
  const m = /"crons"\s*:\s*(\[[\s\S]*?\])/.exec(text);
  if (!m) return null;
  const arrayText = m[1].replace(/\/\/[^\n]*/g, "").replace(/,(\s*\])/g, "$1");
  try {
    const parsed = JSON.parse(arrayText);
    return Array.isArray(parsed) && parsed.every((c) => typeof c === "string") ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The pure decision: violations when the code's declared crons and the wrangler triggers are not the SAME
 * set (after normalisation). FAIL CLOSED when either side is unreadable.
 * @param {unknown} handled - the crons index.ts declares it handles ([CAP_PRODUCER_CRON, HOURLY_CRON])
 * @param {unknown} wrangler - triggers.crons from wrangler.jsonc
 * @returns {string[]}
 */
export function cronSyncViolations(handled, wrangler) {
  if (
    !Array.isArray(handled) ||
    handled.length === 0 ||
    handled.some((c) => typeof c !== "string")
  ) {
    return [
      "could not read the engine's declared crons (CAP_PRODUCER_CRON / HOURLY_CRON) from index.ts",
    ];
  }
  if (
    !Array.isArray(wrangler) ||
    wrangler.length === 0 ||
    wrangler.some((c) => typeof c !== "string")
  ) {
    return ["could not read triggers.crons from apps/engine/wrangler.jsonc"];
  }
  const handledSet = new Set(handled.map(normalise));
  const wranglerSet = new Set(wrangler.map(normalise));
  const violations = [];
  for (const c of handledSet) {
    if (!wranglerSet.has(c)) {
      violations.push(
        `index.ts scheduled() expects cron "${c}" but wrangler.jsonc triggers.crons lacks it — that ` +
          `trigger never fires (a dropped */5 silently loses the fast cap-pause path).`,
      );
    }
  }
  for (const c of wranglerSet) {
    if (!handledSet.has(c)) {
      violations.push(
        `wrangler.jsonc triggers.crons has "${c}" but index.ts scheduled() doesn't name it ` +
          `(CAP_PRODUCER_CRON / HOURLY_CRON) — it would run the HEAVY hourly jobs on that cadence.`,
      );
    }
  }
  return violations;
}

/**
 * Top-level check the guard runs: extract the two constants from index.ts source + the crons from wrangler
 * text, then decide. This is exactly what main() calls, so the test drives the real path with file contents.
 * @param {string} indexSrc @param {string} wranglerText @returns {string[]}
 */
export function checkCronSync(indexSrc, wranglerText) {
  const cap = extractCronConst(indexSrc, "CAP_PRODUCER_CRON");
  const hourly = extractCronConst(indexSrc, "HOURLY_CRON");
  if (cap === null || hourly === null) {
    return [
      "could not read CAP_PRODUCER_CRON / HOURLY_CRON string constants from apps/engine/src/index.ts",
    ];
  }
  return cronSyncViolations([cap, hourly], readWranglerCrons(wranglerText));
}

async function main() {
  const [indexSrc, wranglerText] = await Promise.all([
    readFile(INDEX, "utf8"),
    readFile(WRANGLER, "utf8"),
  ]);
  const violations = checkCronSync(indexSrc, wranglerText);
  if (violations.length > 0) {
    console.error(
      "✖ engine cron config drift — index.ts scheduled() and wrangler.jsonc triggers.crons disagree:\n",
    );
    for (const v of violations) console.error(`  ${v}`);
    console.error(
      "\nKeep apps/engine/wrangler.jsonc triggers.crons EXACTLY the set {CAP_PRODUCER_CRON, HOURLY_CRON} " +
        "from apps/engine/src/index.ts.",
    );
    process.exit(1);
  }
  console.log(
    "✔ engine cron sync: wrangler.jsonc triggers.crons match scheduled()'s handled crons.",
  );
}

// Run only when invoked directly (not when imported by the test — which would trip process.exit).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
