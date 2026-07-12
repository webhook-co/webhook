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
const APPS_DIR = join(ROOT, "apps");
const HARNESS = join(ROOT, "packages/db/test/pg.ts");

/**
 * Identifiers bound to the SCHEMA OWNER — the only role that may TRUNCATE. Either spelling counts:
 * `pg.ownerUrl` (preferred) or the explicit `pg.urlFor({ role: DB_ROLES.owner })`. Covers both a
 * declaration and the bare assignment used when the handle is a module-scope `let` filled in by
 * beforeAll.
 * @param {string} src @returns {Set<string>}
 */
export function ownerHandles(src) {
  const ids = new Set();
  const bind = String.raw`(\w+)\s*=\s*(?:createClient|postgres)\(\s*pg\.`;
  for (const m of src.matchAll(new RegExp(bind + String.raw`ownerUrl`, "g"))) ids.add(m[1]);
  for (const m of src.matchAll(
    new RegExp(bind + String.raw`urlFor\(\s*\{\s*role:\s*DB_ROLES\.owner`, "g"),
  )) {
    ids.add(m[1]);
  }
  return ids;
}

/**
 * Every handle a TRUNCATE is issued on, with the line it happens on. Both postgres.js spellings:
 * a tagged template (``x`truncate …` ``) and `x.unsafe("truncate …")`.
 * @param {string} src @returns {{handle: string, line: number}[]}
 */
export function truncateSites(src) {
  const sites = [];
  const re = /(\w+)(?:<[^`]*>)?(?:`\s*truncate\b|\.unsafe\(\s*["'`]\s*truncate\b)/gi;
  for (const m of src.matchAll(re)) {
    sites.push({ handle: m[1], line: src.slice(0, m.index).split("\n").length });
  }
  return sites;
}

/**
 * Identifiers that hold a rate-limit cap: the `*_MAX_PER_WINDOW` constants themselves, plus any
 * local aliased from one (`const cap = EVENT_DELETE_MAX_PER_WINDOW`).
 * @param {string} src @returns {string[]}
 */
function capIdentifiers(src) {
  const ids = new Set();
  for (const m of src.matchAll(/\b(\w*MAX_PER_WINDOW)\b/g)) ids.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(\w*MAX_PER_WINDOW)\b/g)) {
    ids.add(m[1]);
  }
  return [...ids];
}

/** Escape a value for literal use inside a RegExp. @param {string} s @returns {string} */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Blank out comments so prose can't trip the rules — these files DISCUSS the very patterns the
 * guard hunts for ("see pg.ts", "don't truncate on the provider"), and a comment is not code.
 * Comment bodies are replaced with spaces rather than deleted, so offsets and line numbers still
 * line up with the original source. A `//` preceded by `:` is left alone — that is `https://`, not
 * a comment.
 * @param {string} src @returns {string}
 */
export function blankComments(src) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])(\/\/[^\n]*)/g, (_m, before, comment) => before + blank(comment));
}

/**
 * The fields the EphemeralPostgres harness actually exposes, parsed from its interface in
 * packages/db/test/pg.ts. Returns null if the interface can't be found (⇒ fail closed upstream).
 * @param {unknown} harnessSrc @returns {Set<string> | null}
 */
export function harnessFields(harnessSrc) {
  if (typeof harnessSrc !== "string") return null;
  const block = harnessSrc.match(/export interface EphemeralPostgres \{([\s\S]*?)\n\}/);
  if (!block) return null;
  const fields = new Set();
  // `name: type;` / `name(...)` / `readonly name:` — one per member line, comments ignored.
  for (const m of block[1].matchAll(/^\s*(?:readonly\s+)?(\w+)\s*[?:(]/gm)) fields.add(m[1]);
  return fields.size > 0 ? fields : null;
}

/**
 * The pure decision. Returns a human-readable violation per offending site (empty = safe).
 * @param {string} file repo-relative path, for the message
 * @param {string} src  file contents
 * @param {Set<string> | null} [fields] EphemeralPostgres' members; omit to skip R3
 * @returns {string[]}
 */
export function remoteSafetyViolations(file, rawSrc, fields) {
  if (typeof rawSrc !== "string") return [`${file}: unreadable source (fail closed)`];
  const src = blankComments(rawSrc);
  const violations = [];

  // R3 — a `pg.<field>` the harness does not expose. TypeScript would normally catch this, but the
  // apps exclude their test files from tsconfig, so a stale field silently reads as `undefined`,
  // postgres(undefined) falls back to local env defaults, and the suite dies against Neon with a
  // baffling error. This is how the ownerUrl -> providerUrl rename missed apps/api.
  if (fields) {
    for (const m of src.matchAll(/\bpg\??\.(\w+)/g)) {
      if (!fields.has(m[1])) {
        violations.push(
          `${file}: references \`pg.${m[1]}\`, which EphemeralPostgres does not expose ` +
            `(known: ${[...fields].sort().join(", ")}). It reads as undefined at runtime — the ` +
            `apps' tsconfigs exclude test files, so nothing else catches this before the nightly.`,
        );
      }
    }
  }

  // R1 — TRUNCATE on anything that is not the schema owner. FAIL CLOSED: rather than enumerate the
  // handles known to be wrong (which misses aliases, handles passed into helpers, and whatever the
  // next author invents), require every TRUNCATE to sit on a handle this file binds to the OWNER.
  // TRUNCATE needs ownership; on Neon the provider role owns nothing → 42501.
  const owners = ownerHandles(src);
  for (const { handle, line } of truncateSites(src)) {
    if (owners.has(handle)) continue;
    violations.push(
      `${file}:${line}: TRUNCATEs on \`${handle}\`, which is not bound to the schema owner in this ` +
        `file. TRUNCATE requires OWNERSHIP, and on the nightly's Neon branch the provider role owns ` +
        `nothing (it has BYPASSRLS + DML, but not the owner's rights) → 42501 permission denied. ` +
        `Bind the handle with createClient(pg.ownerUrl) — RLS never filters TRUNCATE, so the owner's ` +
        `FORCE RLS is not in the way.`,
    );
  }

  // R2 — seeding a wall-clock rate-limit window with cap-many round-trips. Audit rows are stamped
  // `created_at := now()` — the TRANSACTION timestamp — and the limiters count inside a 60s WALL
  // CLOCK. Any cap-many loop of awaited DB work (a raw appendAuditEntry, a full handler call, a
  // delete) outlives that window on a remote DB, so the rows it seeds are born already expired, the
  // limiter counts zero, and the test FALSE-PASSES. Keyed on the loop's BOUND, not on what it calls:
  // #413 fixed the appendAuditEntry shape but the original defect was a loop of handler reveals.
  const caps = capIdentifiers(src);
  if (caps.length > 0) {
    const bound = new RegExp(`for\\s*\\([^)]*<\\s*(?:${caps.map(escapeRe).join("|")})\\b`);
    const lines = src.split("\n");
    for (const [i, line] of lines.entries()) {
      if (!bound.test(line)) continue;
      const body = lines.slice(i + 1, i + 13).join("\n");
      if (/\bawait\b/.test(body)) {
        violations.push(
          `${file}:${i + 1}: seeds a rate-limit window with cap-many awaited round-trips. Every audit ` +
            `row is stamped with its TRANSACTION's now(), and the limiter counts inside a 60s WALL-CLOCK ` +
            `window — on Neon this loop outlasts the window it is filling, so the rows expire before the ` +
            `assertion and the test FALSE-PASSES (resolves instead of rejecting). Seed it in one shot: ` +
            `seedAuditChain(tx, key, input, count).`,
        );
      }
    }
  }

  return violations;
}

/** Every `*.pg.test.ts` under apps/ — the app-level suites `pnpm test:db` also runs on Neon.
 *  @param {string} dir @returns {Promise<string[]>} absolute paths */
async function findAppPgTests(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await findAppPgTests(full)));
    else if (entry.name.endsWith(".pg.test.ts")) out.push(full);
  }
  return out;
}

/** Read every source the nightly runs against Neon: packages/db tests + helpers, and the apps'
 *  own *.pg.test.ts suites. @returns {Promise<{file: string, src: string}[]>} */
export async function readDbTestSources() {
  const dbFiles = (await readdir(DB_TEST_DIR))
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((name) => join(DB_TEST_DIR, name));
  const appFiles = (await findAppPgTests(APPS_DIR)).sort();
  return Promise.all(
    [...dbFiles, ...appFiles].map(async (path) => ({
      file: path.slice(ROOT.length + 1),
      src: await readFile(path, "utf8"),
    })),
  );
}

async function main() {
  const [sources, fields] = await Promise.all([
    readDbTestSources(),
    readFile(HARNESS, "utf8").then(harnessFields),
  ]);
  if (sources.length === 0) {
    console.error("✖ remote-db-test-guard: no db test sources found — cannot prove remote safety.");
    process.exit(1);
  }
  if (!fields) {
    console.error(
      "✖ remote-db-test-guard: could not read EphemeralPostgres' members from packages/db/test/pg.ts.",
    );
    process.exit(1);
  }
  const violations = sources.flatMap(({ file, src }) => remoteSafetyViolations(file, src, fields));
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
