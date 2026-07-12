#!/usr/bin/env node
// Remote-DB test-safety guard. The packages/db suite runs twice with DIFFERENT privileges:
//
//   - locally / on the fast CI lane: a throwaway cluster whose provider role is the `postgres`
//     SUPERUSER, which bypasses every ACL check;
//   - nightly (`nightly-rls`): a real Neon branch whose provider role (`neondb_owner`) is NOT a
//     superuser. It has BYPASSRLS and DML on the app tables, but it does NOT own them — it holds
//     `webhook_owner` membership with inherit_option = f, so it does not carry the owner's rights.
//
// Anything the local superuser papers over is therefore invisible until the nightly goes red at
// 04:00. This guard makes those two failure modes red at lint time instead. Both have already cost
// a nightly (issue #383): R1 is the 2026-07-12 `42501 permission denied for table …` on TRUNCATE;
// R2 is the false-passing rate-limiter class that also bit the reveal limiter in #413.
//
// Wired into the `lint` script; the pure brain (remoteSafetyViolations) is unit-tested in
// scripts/remote-db-test-guard.test.mjs against the REAL committed sources.
//
// FAIL CLOSED: if the test sources can't be read, or the glob matches nothing, that is itself a
// violation — we cannot prove the suite is remote-safe, so we block.

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_TEST_DIR = join(ROOT, "packages/db/test");

/** Documented for the guard's own test — the suite the nightly actually runs. */
export const DB_TEST_GLOB = "packages/db/test/*.ts";

/**
 * Identifiers bound to the PROVIDER connection: `x = createClient(pg.providerUrl)` or
 * `x = postgres(pg.providerUrl, …)`. Covers both a declaration (`const x = …`) and the bare
 * assignment used when the handle is a module-scope `let` filled in by beforeAll.
 * @param {string} src @returns {string[]}
 */
function providerHandles(src) {
  const ids = new Set();
  for (const m of src.matchAll(/(\w+)\s*=\s*(?:createClient|postgres)\(\s*pg\.providerUrl/g)) {
    ids.add(m[1]);
  }
  return [...ids];
}

/** Escape a value for literal use inside a RegExp. @param {string} s @returns {string} */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The pure decision. Returns a human-readable violation per offending site (empty = safe).
 * @param {string} file repo-relative path, for the message
 * @param {string} src  file contents
 * @returns {string[]}
 */
export function remoteSafetyViolations(file, src) {
  if (typeof src !== "string") return [`${file}: unreadable source (fail closed)`];
  const violations = [];

  // R1 — TRUNCATE through the provider handle. The provider role does not own the tables on a
  // managed Postgres, and TRUNCATE requires ownership (or an explicit TRUNCATE grant): 42501.
  for (const id of providerHandles(src)) {
    const tagged = new RegExp(`\\b${escapeRe(id)}\`\\s*truncate\\b`, "i");
    const unsafe = new RegExp(`\\b${escapeRe(id)}\\.unsafe\\(\\s*["'\`]\\s*truncate\\b`, "i");
    if (tagged.test(src) || unsafe.test(src)) {
      violations.push(
        `${file}: \`${id}\` is the PROVIDER connection (pg.providerUrl) and TRUNCATEs. The provider ` +
          `role does not own the tables on Neon → 42501. Truncate on the schema owner instead: ` +
          `createClient(pg.urlFor({ role: DB_ROLES.owner })) — RLS never filters TRUNCATE.`,
      );
    }
  }

  // R2 — seeding a wall-clock rate-limit window with cap-many serial appends. Each appendAuditEntry
  // is 3 round-trips and every row is stamped with the TRANSACTION's now(), so on a remote DB the
  // loop outlives the limiter's window and the seeded rows are born expired: the test false-passes.
  const lines = src.split("\n");
  for (const [i, line] of lines.entries()) {
    if (!/for\s*\(.*<\s*\w*MAX_PER_WINDOW/.test(line)) continue;
    const body = lines.slice(i + 1, i + 13).join("\n");
    if (/\bappendAuditEntry\s*\(/.test(body)) {
      violations.push(
        `${file}:${i + 1}: seeds a rate-limit window with cap-many serial appendAuditEntry calls ` +
          `(3 round-trips each, all stamped with the transaction's now()). On Neon the loop outlasts ` +
          `the limiter's wall-clock window, so the rows expire before the assertion and the test ` +
          `FALSE-PASSES. Use seedAuditChain(tx, key, input, count) — one insert, one round-trip.`,
      );
    }
  }

  return violations;
}

/** Read every packages/db test source (tests + their helpers). @returns {Promise<{file: string, src: string}[]>} */
export async function readDbTestSources() {
  const names = (await readdir(DB_TEST_DIR)).filter((f) => f.endsWith(".ts")).sort();
  return Promise.all(
    names.map(async (name) => ({
      file: `packages/db/test/${name}`,
      src: await readFile(join(DB_TEST_DIR, name), "utf8"),
    })),
  );
}

async function main() {
  const sources = await readDbTestSources();
  if (sources.length === 0) {
    console.error("✖ remote-db-test-guard: no db test sources found — cannot prove remote safety.");
    process.exit(1);
  }
  const violations = sources.flatMap(({ file, src }) => remoteSafetyViolations(file, src));
  if (violations.length > 0) {
    console.error(
      "✖ packages/db tests that pass locally but FAIL (or false-pass) against the nightly Neon branch:\n",
    );
    for (const v of violations) console.error(`  ${v}\n`);
    process.exit(1);
  }
  console.log(
    `✔ remote-db-test safety: ${sources.length} db test sources hold under the Neon provider role.`,
  );
}

// Run only when invoked directly (not when imported by the test — which would trip process.exit).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
