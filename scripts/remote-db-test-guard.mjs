#!/usr/bin/env node
// Remote-DB test-safety guard. The packages/db suite runs twice with DIFFERENT privileges:
//
//   - locally / on the fast CI lane: a throwaway cluster whose provider role is the `postgres`
//     SUPERUSER, which bypasses every ACL check;
//   - nightly (`nightly-rls`): a real Neon branch whose provider role (`neondb_owner`) is NOT a
//     superuser. It has BYPASSRLS and DML on the app tables, but it does NOT own them — it holds
//     `webhook_owner` membership with inherit_option = f, so it does not carry the owner's rights.
//
// Measured on the real Neon branch (2026-07-21), that provider role can do exactly this much:
//
//   SELECT/INSERT/UPDATE/DELETE on owner-owned tables .... true   (even where relacl is null)
//   TRUNCATE ............................................. false  → R1
//   owner-only DDL (CREATE TRIGGER/INDEX, ALTER TABLE …) . false  → R1
//   EXECUTE on a function revoked from PUBLIC ............ false  → R5
//   pg_has_role(…, 'webhook_owner', 'USAGE') ............. false  (MEMBER = true, set_option = f)
//
// Anything the local superuser papers over is therefore invisible until the nightly goes red at
// 04:00. This guard makes those failure modes red at lint time instead. Each has already cost a
// nightly: R1 is owner-only DDL on the provider handle — the 2026-07-12 `42501 permission denied
// for table …` on TRUNCATE (#383), then the 2026-07-19/20 poison CREATE TRIGGER on `usage` (#637)
// that the TRUNCATE-only first cut let straight through; R2 is the false-passing rate-limiter class
// that also bit the reveal limiter in #413; R5 is EXECUTE on an owner-only FUNCTION — the 2026-07-21
// `42501 permission denied for function activation_weekly_review` (#717), which R1 could never see
// because it is not DDL at all but a plain `select fn()`.
//
// R5's owner-only set is DERIVED from the migrations (`revoke execute … from public`), never
// hand-listed, and it follows one hop through the typed wrappers in packages/db/src — #717's second
// failure never named the function in the test at all, reaching it via readActivationWeeklyReview().
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
const MIGRATIONS_DIR = join(ROOT, "packages/db/db/migrations");
const DB_SRC_DIR = join(ROOT, "packages/db/src");
const CONSTANTS = join(ROOT, "packages/db/src/constants.ts");

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
 * Every owner-only DDL statement, with the handle it runs on and the line. On a table you do NOT
 * own, Postgres rejects TRUNCATE, CREATE/DROP TRIGGER, CREATE/DROP INDEX, ALTER TABLE, CREATE/DROP
 * POLICY and COMMENT ON with `42501` — and on the nightly's Neon branch the provider role owns
 * nothing. TRUNCATE was merely the first of these to reach the nightly (#383); a poison CREATE
 * TRIGGER on `usage` was the second (#637), which the TRUNCATE-only first cut of this rule missed.
 *
 * CREATE/DROP FUNCTION is deliberately EXCLUDED: creating a function needs CREATE on the SCHEMA, not
 * OWNERSHIP of a table, and the provider role holds it on Neon — #637's `create or replace function`
 * on the provider handle SUCCEEDED (the 42501 was on its very next line, the `create trigger`).
 * Flagging function DDL would be a false requirement.
 *
 * Both postgres.js spellings: a tagged template (``x`create trigger …` ``) and
 * `x.unsafe("create trigger …")`. `ddl` is the matched verb, normalised for the message.
 * @param {string} src @returns {{handle: string, line: number, ddl: string}[]}
 */
export function ownerOnlyDdlSites(src) {
  const ddl = String.raw`truncate|create\s+(?:or\s+replace\s+|constraint\s+)?trigger|drop\s+trigger|create\s+(?:unique\s+)?index|drop\s+index|alter\s+table|create\s+policy|drop\s+policy|comment\s+on`;
  const re = new RegExp(
    String.raw`(\w+)(?:<[^\x60]*>)?(?:\x60\s*|\.unsafe\(\s*["'\x60]\s*)(${ddl})\b`,
    "gi",
  );
  const sites = [];
  for (const m of src.matchAll(re)) {
    sites.push({
      handle: m[1],
      line: src.slice(0, m.index).split("\n").length,
      ddl: m[2].replace(/\s+/g, " ").toLowerCase(),
    });
  }
  return sites;
}

/**
 * Blank SQL comments so a migration's prose can't be read as a statement (these files DISCUSS the
 * grants they make). Bodies become spaces so offsets still line up.
 * @param {string} sql @returns {string}
 */
export function blankSqlComments(sql) {
  const blank = (/** @type {string} */ m) => m.replace(/[^\n]/g, " ");
  return sql.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/--[^\n]*/g, blank);
}

/**
 * DB_ROLES exactly as packages/db/src/constants.ts declares it: property key -> SQL role name.
 * PARSED, never hand-listed — a hand-maintained role list in the harness is precisely what caused
 * the 28P01 nightly (#423). Returns null if the block can't be found (⇒ fail closed upstream).
 * @param {unknown} constantsSrc @returns {Map<string, string> | null}
 */
export function dbRoles(constantsSrc) {
  if (typeof constantsSrc !== "string") return null;
  const block = constantsSrc.match(/export const DB_ROLES = \{([\s\S]*?)\n\} as const;/);
  if (!block) return null;
  const roles = new Map();
  for (const m of block[1].matchAll(/^\s+(\w+):\s*"(\w+)"/gm)) roles.set(m[1], m[2]);
  return roles.size > 0 ? roles : null;
}

/**
 * The UP section of a dbmate migration. A `grant execute` that only exists below `-- migrate:down`
 * is regained on ROLLBACK, not held by the live schema — reading it would mark a function reachable
 * by a role that cannot actually reach it, silently switching R5 off for that function. Down-section
 * EXECUTE grants are real here (0028, 0030, 0069, 0070, 0082, 0083, 0091).
 *
 * Truncation must happen BEFORE comment-blanking, because the marker itself is a `--` comment.
 * @param {string} sql @returns {string}
 */
function upSection(sql) {
  const marker = sql.match(/^--\s*migrate:down\b/m);
  return marker ? sql.slice(0, marker.index) : sql;
}

/** Every function named in a REVOKE/GRANT target list, schema qualification and argument lists
 *  stripped: `public.f(date, text), g()` -> ["f", "g"]. @param {string} list @returns {string[]} */
function functionNames(list) {
  return list
    .replace(/\([^)]*\)/g, "")
    .split(",")
    .map((t) => t.trim().match(/(?:\w+\.)?(\w+)$/)?.[1])
    .filter((n) => typeof n === "string");
}

// Postgres accepts far more spellings than the obvious one: FUNCTION or ROUTINE, an optional schema
// qualification, an optional (and optionally typed) argument list, a comma-separated target list,
// and `FROM GROUP PUBLIC`. Matching only `function f() from public` would silently derive NOTHING
// from a legitimate revoke — a rule that quietly stops working reads exactly like a rule that passes.
const REVOKE_EXECUTE =
  /revoke\s+execute\s+on\s+(?:function|routine)\s+([^;]*?)\s+from\s+(?:group\s+)?public\b/gi;
const GRANT_EXECUTE = /grant\s+execute\s+on\s+(?:function|routine)\s+([^;]*?)\s+to\s+([^;]+)/gi;
const BLANKET_REVOKE =
  /revoke\s+execute\s+on\s+all\s+(?:functions|routines)\s+in\s+schema\s+\w+\s+from\s+(?:group\s+)?public\b/gi;

/**
 * Functions whose EXECUTE was REVOKED FROM PUBLIC, mapped to the roles later granted EXECUTE back
 * (an empty set ⇒ the schema owner is the only caller).
 *
 * Postgres grants EXECUTE to PUBLIC by default, so every other function in the schema is callable by
 * the provider role — which is exactly why only the revoked one broke the nightly. Derived from the
 * migrations so a future `revoke execute … from public` is covered the day it lands.
 * @param {string[]} migrations raw SQL of every migration (UP sections only are honoured)
 * @returns {Map<string, Set<string>>}
 */
export function ownerOnlyFunctions(migrations) {
  /** @type {Map<string, Set<string>>} */
  const acl = new Map();
  if (!Array.isArray(migrations)) return acl;
  const cleaned = migrations
    .filter((s) => typeof s === "string")
    .map((s) => blankSqlComments(upSection(s)));
  for (const sql of cleaned) {
    for (const m of sql.matchAll(REVOKE_EXECUTE)) {
      for (const name of functionNames(m[1])) if (!acl.has(name)) acl.set(name, new Set());
    }
  }
  // A second pass, because a grant may live in a LATER migration than the revoke.
  for (const sql of cleaned) {
    for (const m of sql.matchAll(GRANT_EXECUTE)) {
      const names = functionNames(m[1]).filter((n) => acl.has(n));
      if (names.length === 0) continue;
      for (const r of m[2].split(",").map((s) => s.trim())) {
        if (!/^\w+$/.test(r) || r.toLowerCase() === "public") continue;
        for (const name of names) acl.get(name).add(r);
      }
    }
  }
  return acl;
}

/**
 * Schema-wide EXECUTE revokes, which this rule CANNOT model: it maps function NAMES to entitled
 * handles, and `revoke … on all functions in schema public` names nothing. Deriving nothing from one
 * would leave the rule silently switched off, so main() treats any hit as fatal.
 * @param {string[]} migrations @returns {string[]}
 */
export function unmodelableExecuteRevokes(migrations) {
  const found = [];
  if (!Array.isArray(migrations)) return found;
  for (const sql of migrations.filter((s) => typeof s === "string")) {
    const clean = blankSqlComments(upSection(sql));
    for (const m of clean.matchAll(BLANKET_REVOKE)) found.push(m[0].replace(/\s+/g, " "));
  }
  return found;
}

/**
 * Every connection handle this file binds, mapped to the ROLE it authenticates as. Generalises
 * ownerHandles() past "is it the owner" so a role that was granted EXECUTE can be recognised too.
 * The provider gets a sentinel: it is a role, but never one that holds an owner-only grant.
 * @param {string} src @param {Map<string, string>} [roles]
 * @returns {Map<string, string>}
 */
export function handleRoles(src, roles) {
  const map = new Map();
  const bind = String.raw`(\w+)\s*=\s*(?:createClient|postgres)\(\s*pg\.`;
  for (const m of src.matchAll(new RegExp(bind + String.raw`ownerUrl`, "g"))) {
    map.set(m[1], roles?.get("owner") ?? "webhook_owner");
  }
  for (const m of src.matchAll(new RegExp(bind + String.raw`providerUrl`, "g"))) {
    map.set(m[1], "__provider__");
  }
  const viaRole = new RegExp(bind + String.raw`urlFor\(\s*\{\s*role:\s*DB_ROLES\.(\w+)`, "g");
  for (const m of src.matchAll(viaRole)) {
    const role = roles?.get(m[2]);
    if (role) map.set(m[1], role);
  }
  return map;
}

/**
 * Every SQL string this file issues, with the handle it runs on. Both postgres.js spellings: a
 * tagged template (optionally carrying a generic row type) and `x.unsafe("…")`.
 * @param {string} src @returns {{handle: string, body: string, index: number, line: number}[]}
 */
export function sqlSites(src) {
  const sites = [];
  const at = (/** @type {number} */ i) => src.slice(0, i).split("\n").length;
  for (const m of src.matchAll(
    new RegExp(String.raw`(\w+)(?:<[^\x60]*>)?\x60([^\x60]*)\x60`, "g"),
  )) {
    sites.push({ handle: m[1], body: m[2], index: m.index, line: at(m.index) });
  }
  for (const m of src.matchAll(/(\w+)\.unsafe\(\s*(["'\x60])([\s\S]*?)\2/g)) {
    sites.push({ handle: m[1], body: m[3], index: m.index, line: at(m.index) });
  }
  return sites;
}

/**
 * Blank quoted string literals (spaces, so offsets and line numbers survive). A wrapper's NAME shows
 * up in prose that is not code — `describe("readActivationWeeklyReview (typed reader)", …)` reads as
 * a call to it with a handle named `typed`. Backtick templates are deliberately LEFT ALONE: they
 * carry the SQL the direct-call arm has to read.
 * @param {string} src @returns {string}
 */
export function blankQuotedStrings(src) {
  const blank = (/** @type {string} */ m) => m.replace(/[^\n]/g, " ");
  return src.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, blank);
}

/** A call the test ASSERTS is rejected is not a mistake — it is the denial being pinned.
 *  @param {string} src @param {number} index @returns {boolean} */
function isExpectedRejection(src, index) {
  const before = src.slice(Math.max(0, index - 48), index);
  return /expect\(\s*(?:\(\s*\)\s*=>\s*)?(?:async\s+)?$/.test(before);
}

/**
 * The typed wrappers in packages/db/src that ISSUE an owner-only call, mapped to the function they
 * call. #717's second failure never named the function in the test at all — it went through
 * `readActivationWeeklyReview(provider)` — so a rule that only reads the test file's own SQL catches
 * half the incident.
 * @param {{file: string, src: string}[]} dbSources @param {Map<string, Set<string>>} ownerOnly
 * @returns {Map<string, string>} wrapper name -> owner-only function it calls
 */
export function ownerOnlyReaders(dbSources, ownerOnly) {
  const readers = new Map();
  if (!Array.isArray(dbSources) || !ownerOnly) return readers;
  for (const { src } of dbSources) {
    if (typeof src !== "string") continue;
    const clean = blankComments(src);
    for (const m of clean.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\(/g)) {
      const end = clean.indexOf("\n}", m.index);
      const body = clean.slice(m.index, end === -1 ? clean.length : end);
      for (const fn of ownerOnly.keys()) {
        if (new RegExp(String.raw`\b${fn}\s*\(`).test(body)) readers.set(m[1], fn);
      }
    }
  }
  return readers;
}

/**
 * R5 — EXECUTE on an owner-only function through a handle that is not entitled to it.
 *
 * The fourth provider-vs-owner incident (#717). Unlike R1 this is NOT DDL — it is a plain
 * `select fn()` — so R1's verb list was structurally blind to it. Measured on the real Neon branch,
 * the provider role has table DML (hence R1 allows `delete from`) but
 * `has_function_privilege('activation_weekly_review()','EXECUTE') = false`.
 *
 * FAIL CLOSED, like R1: the handle must be bound, in THIS file, to a role the migrations actually
 * entitle — anything unrecognised is a violation, so the rule cannot be walked around by renaming.
 * @param {string} file @param {unknown} rawSrc
 * @param {{ownerOnly: Map<string, Set<string>>, roles?: Map<string, string>, readers?: Map<string, string> | Set<string>} | undefined} ctx
 * @returns {string[]}
 */
export function ownerOnlyExecuteViolations(file, rawSrc, ctx) {
  if (typeof rawSrc !== "string") return [`${file}: unreadable source (fail closed)`];
  if (!ctx?.ownerOnly || ctx.ownerOnly.size === 0) return [];
  const src = blankComments(rawSrc);
  const ownerRole = ctx.roles?.get("owner") ?? "webhook_owner";
  const handles = handleRoles(src, ctx.roles);
  const violations = [];

  /** @param {string} handle @param {number} index @param {number} line @param {string} fn @param {string} via */
  const check = (handle, index, line, fn, via) => {
    if (isExpectedRejection(src, index)) return;
    const allowed = new Set([ownerRole, ...(ctx.ownerOnly.get(fn) ?? [])]);
    const role = handles.get(handle);
    if (role && allowed.has(role)) return;
    violations.push(
      `${file}:${line}: calls the owner-only function \`${fn}()\`${via} on \`${handle}\`, which this ` +
        `file does not bind to a role holding EXECUTE (entitled: ${[...allowed].join(", ")}). ` +
        `Migration grants revoked EXECUTE on it from PUBLIC, and on the nightly's Neon branch the ` +
        `provider role holds webhook_owner membership with inherit_option = f AND set_option = f — ` +
        `it carries none of the owner's rights → 42501 permission denied for function ${fn}. A local ` +
        `superuser papers over this; the nightly does not (#717). Bind the handle with ` +
        `createClient(pg.ownerUrl).`,
    );
  };

  for (const site of sqlSites(src)) {
    // Quoted literals INSIDE the SQL are names, not calls: `has_function_privilege(role,
    // 'activation_weekly_review()', 'EXECUTE')` introspects the ACL, it does not invoke the function
    // — and pinning that ACL is exactly what a good test does.
    const body = blankQuotedStrings(site.body);
    for (const fn of ctx.ownerOnly.keys()) {
      if (new RegExp(String.raw`\b${fn}\s*\(`).test(body)) {
        check(site.handle, site.index, site.line, fn, "");
      }
    }
  }

  const code = blankQuotedStrings(src);
  for (const reader of ctx.readers?.keys() ?? []) {
    const fn = ctx.readers instanceof Map ? (ctx.readers.get(reader) ?? reader) : reader;
    for (const m of code.matchAll(new RegExp(String.raw`\b${reader}\s*\(\s*(\w+)`, "g"))) {
      check(m[1], m.index, code.slice(0, m.index).split("\n").length, fn, ` (via ${reader}())`);
    }
  }

  return violations;
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
 * R4 — everything that touches the shared Neon branch must be SERIALIZED.
 *
 * Postgres roles are CLUSTER-GLOBAL: they are not scoped to the per-file test database, so every
 * startEphemeralPostgres() ALTERs the passwords of the SAME shared roles on the branch. Two suites
 * provisioning at the same time invalidate each other's credentials mid-run, and the loser dies on
 * `password authentication failed for user '…'` — nothing to do with the code under test.
 *
 * The root `test:db` script must therefore keep each multi-package turbo invocation serial. Without
 * `--concurrency=1`, turbo runs @webhook-co/api and @webhook-co/web in PARALLEL — a live race that
 * was invisible only because a failing db#test short-circuited the `&&` before the apps ever ran.
 *
 * @param {unknown} script the root package.json `test:db` script
 * @returns {string[]}
 */
export function testDbSerializationViolations(script) {
  if (typeof script !== "string" || script.trim() === "") {
    return ["package.json: no `test:db` script — cannot prove the Neon suites are serialized."];
  }
  const violations = [];
  for (const invocation of script.split("&&").map((s) => s.trim())) {
    // Only a turbo invocation that fans out to MORE THAN ONE package can race with itself.
    const filters = invocation.match(/--filter=/g)?.length ?? 0;
    if (!/\bturbo run\b/.test(invocation) || filters < 2) continue;
    if (!/--concurrency=1\b/.test(invocation)) {
      violations.push(
        `package.json test:db: \`${invocation}\` fans out to ${filters} packages WITHOUT ` +
          `--concurrency=1, so turbo runs them in PARALLEL. Postgres roles are cluster-global — ` +
          `each suite's startEphemeralPostgres() rotates the SAME roles' passwords on the Neon ` +
          `branch, so concurrent suites invalidate each other's credentials and one dies on ` +
          `\`password authentication failed\`. Add --concurrency=1, or split them with &&.`,
      );
    }
  }
  return violations;
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

  // R1 — owner-only DDL (TRUNCATE, CREATE/DROP TRIGGER, CREATE/DROP INDEX, ALTER TABLE, the policy
  // DDL) on anything that is not the schema owner. FAIL CLOSED: rather than enumerate the handles
  // known to be wrong (which misses aliases, handles passed into helpers, and whatever the next
  // author invents), require every such statement to sit on a handle this file binds to the OWNER.
  // These need ownership; on Neon the provider role owns nothing → 42501. TRUNCATE was the first to
  // reach the nightly (#383), a poison CREATE TRIGGER on `usage` the second (#637) — same class,
  // same 42501, both invisible to a local superuser and to the TRUNCATE-only first cut of this rule.
  const owners = ownerHandles(src);
  for (const { handle, line, ddl } of ownerOnlyDdlSites(src)) {
    if (owners.has(handle)) continue;
    violations.push(
      `${file}:${line}: issues \`${ddl}\` on \`${handle}\`, which is not bound to the schema owner in ` +
        `this file. ${ddl.toUpperCase()} requires OWNERSHIP of the table, and on the nightly's Neon ` +
        `branch the provider role owns nothing (it has BYPASSRLS + DML, but not the owner's rights) → ` +
        `42501 permission denied. Bind the handle with createClient(pg.ownerUrl) — this is exactly ` +
        `what broke nightly-rls on #383 (TRUNCATE) and #637 (a poison CREATE TRIGGER on \`usage\`).`,
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

/** Every committed migration — the SOURCE OF TRUTH for which functions are owner-only.
 *  @returns {Promise<{file: string, src: string}[]>} */
export async function readMigrationSources() {
  // NUMBERED migrations only. A bare `*.sql` glob also picks up the dotfile
  // `.better-auth.schema.sql`, which is a generated reference dump, not a migration — it inflated
  // the reported count to 93 against a real 92. Mirrors migrationCount() in packages/db/test/migrate.ts.
  const names = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_[\w-]+\.sql$/.test(f)).sort();
  return Promise.all(
    names.map(async (name) => ({
      file: join("packages/db/db/migrations", name),
      src: await readFile(join(MIGRATIONS_DIR, name), "utf8"),
    })),
  );
}

/** packages/db/src — where the typed wrappers that issue owner-only calls live.
 *  @returns {Promise<{file: string, src: string}[]>} */
export async function readDbSrcSources() {
  const names = (await readdir(DB_SRC_DIR))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort();
  return Promise.all(
    names.map(async (name) => ({
      file: join("packages/db/src", name),
      src: await readFile(join(DB_SRC_DIR, name), "utf8"),
    })),
  );
}

async function main() {
  const [sources, fields, pkg, migrations, dbSrc, roles] = await Promise.all([
    readDbTestSources(),
    readFile(HARNESS, "utf8").then(harnessFields),
    readFile(join(ROOT, "package.json"), "utf8").then(JSON.parse),
    readMigrationSources(),
    readDbSrcSources(),
    readFile(CONSTANTS, "utf8").then(dbRoles),
  ]);
  // FAIL CLOSED on R5's inputs: an empty derivation would silently make the rule a no-op, which is
  // exactly the "a guard that matches nothing reads as clean" failure mode.
  if (migrations.length === 0) {
    console.error(
      "✖ remote-db-test-guard: no migrations found — cannot derive the owner-only set.",
    );
    process.exit(1);
  }
  if (!roles) {
    console.error(
      "✖ remote-db-test-guard: could not parse DB_ROLES from packages/db/src/constants.ts.",
    );
    process.exit(1);
  }
  const blanket = unmodelableExecuteRevokes(migrations.map((m) => m.src));
  if (blanket.length > 0) {
    console.error(
      `✖ remote-db-test-guard: a schema-wide EXECUTE revoke (${blanket[0]}) cannot be modelled by ` +
        `R5, which maps function NAMES to entitled handles. Revoke per-function, or teach the rule.`,
    );
    process.exit(1);
  }
  const ownerOnly = ownerOnlyFunctions(migrations.map((m) => m.src));
  // THE FLOOR. R5 short-circuits on an empty set, so a derivation that silently stops matching
  // would print a ✔ meaning "the rule did nothing" — the exact way a guard becomes a latent lie.
  if (ownerOnly.size === 0) {
    console.error(
      `✖ remote-db-test-guard: derived ZERO owner-only functions from ${migrations.length} ` +
        `migrations, so R5 would be a no-op. Expected at least one ` +
        `\`revoke execute on function … from public\` in packages/db/db/migrations. If that revoke ` +
        `was removed on purpose, delete R5 rather than letting it pass vacuously.`,
    );
    process.exit(1);
  }
  const readers = ownerOnlyReaders(dbSrc, ownerOnly);
  const execCtx = { ownerOnly, roles, readers };
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
  const violations = [
    ...sources.flatMap(({ file, src }) => remoteSafetyViolations(file, src, fields)),
    ...sources.flatMap(({ file, src }) => ownerOnlyExecuteViolations(file, src, execCtx)),
    ...testDbSerializationViolations(pkg.scripts?.["test:db"]),
  ];
  if (violations.length > 0) {
    console.error(
      "✖ suites that pass locally but FAIL (or false-pass) against the nightly Neon branch:\n",
    );
    for (const v of violations) console.error(`  ${v}\n`);
    process.exit(1);
  }
  console.log(
    `✔ remote-db-test safety: ${sources.length} sources hold under the Neon provider role ` +
      `(incl. EXECUTE on ${ownerOnly.size} owner-only function(s) derived from ${migrations.length} ` +
      `migrations, reached through ${readers.size} typed wrapper(s)), and test:db serializes every ` +
      `suite that touches the shared branch.`,
  );
}

// Run only when invoked directly (not when imported by the test — which would trip process.exit).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
