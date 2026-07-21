import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  blankComments,
  blankQuotedStrings,
  dbRoles,
  harnessFields,
  ownerOnlyExecuteViolations,
  ownerOnlyFunctions,
  ownerOnlyReaders,
  readDbSrcSources,
  readDbTestSources,
  readMigrationSources,
  remoteSafetyViolations,
  testDbSerializationViolations,
  unmodelableExecuteRevokes,
} from "./remote-db-test-guard.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS_SRC = readFileSync(join(ROOT, "packages/db/test/pg.ts"), "utf8");
const FIELDS = harnessFields(HARNESS_SRC);

// The guard running against PRODUCTION: every real, committed source the nightly runs against Neon.
// This is the assertion that actually blocks the bug — the unit cases below only pin the brain's edges.
test("every source the nightly runs is remote-safe (no violations on the committed tree)", async () => {
  const sources = await readDbTestSources();
  // Vacuity checks: a glob matching nothing — or missing the apps' suites, as the first cut of this
  // guard did — would make every assertion below trivially true.
  assert.ok(sources.length > 40, `expected the db test suite, got ${sources.length} files`);
  assert.ok(
    sources.some((s) => s.file.startsWith("apps/")),
    "the apps' *.pg.test.ts suites run on Neon too and must be scanned",
  );
  const violations = sources.flatMap(({ file, src }) => remoteSafetyViolations(file, src, FIELDS));
  assert.deepEqual(violations, []);
});

test("the scan reaches both suites the nightly runs (packages/db AND the apps)", async () => {
  const files = (await readDbTestSources()).map((s) => s.file);
  assert.ok(files.some((f) => f.startsWith("packages/db/test/")));
  assert.ok(files.some((f) => f.startsWith("apps/") && f.endsWith(".pg.test.ts")));
});

// ── R4: everything that touches the shared Neon branch must be SERIALIZED ──────────────────────
// Postgres roles are CLUSTER-GLOBAL, so every startEphemeralPostgres() ALTERs the passwords of the
// same shared roles. Two suites provisioning concurrently invalidate each other's credentials and
// the loser dies on `password authentication failed for user '…'`. The apps' turbo task ran api and
// web in PARALLEL — a real race that was invisible only because a failing db#test short-circuited
// the `&&` before the apps ever ran.

test("the real test:db script serializes every suite that touches the branch", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(testDbSerializationViolations(pkg.scripts?.["test:db"]), []);
});

test("R4 flags the apps' turbo task running api and web in parallel", () => {
  const script =
    "turbo run test --filter=@webhook-co/db && turbo run test:db --filter=@webhook-co/api --filter=@webhook-co/web";
  const v = testDbSerializationViolations(script);
  assert.equal(v.length, 1);
  assert.match(v[0], /concurrency=1/);
});

test("R4 flags packages/db sharing a turbo invocation with the apps (no && to serialize them)", () => {
  const script = "turbo run test:db --filter=@webhook-co/db --filter=@webhook-co/api";
  assert.equal(testDbSerializationViolations(script).length, 1);
});

test("R4 accepts the serialized script", () => {
  const script =
    "turbo run test --filter=@webhook-co/db && turbo run test:db --filter=@webhook-co/api --filter=@webhook-co/web --concurrency=1";
  assert.deepEqual(testDbSerializationViolations(script), []);
});

test("R4 fails closed on a missing script", () => {
  assert.equal(testDbSerializationViolations(undefined).length, 1);
});

// ── R3: a `pg.<field>` the harness does not expose ────────────────────────────────────────────
// The apps exclude test files from tsconfig, so TypeScript does NOT catch a stale harness field
// there: it reads as undefined, postgres(undefined) silently falls back to local env defaults, and
// the suite dies against Neon. This is exactly how the ownerUrl -> providerUrl rename missed
// apps/api/src/stripe-webhook.pg.test.ts.

test("harnessFields parses EphemeralPostgres' real members off the committed harness", () => {
  // The two handles whose confusion caused #383 are now BOTH named, and both mean what they say.
  assert.ok(FIELDS.has("providerUrl")); // BYPASSRLS, owns nothing → must not TRUNCATE
  assert.ok(FIELDS.has("ownerUrl")); // the schema owner → the only role that may TRUNCATE
  assert.ok(FIELDS.has("urlFor"));
  assert.ok(FIELDS.has("stop"));
  assert.equal(FIELDS.has("superuserUrl"), false); // never existed; the harness is not a superuser on Neon
});

test("harnessFields fails closed when the interface cannot be read", () => {
  assert.equal(harnessFields("export interface Something Else {}"), null);
  assert.equal(harnessFields(undefined), null);
});

test("R3 flags a reference to a harness field that does not exist", () => {
  const v = remoteSafetyViolations(
    "x.pg.test.ts",
    "admin = createClient(pg.superuserUrl);",
    FIELDS,
  );
  assert.equal(v.length, 1);
  assert.match(v[0], /pg\.superuserUrl/);
});

test("R3 allows every field the harness really exposes", () => {
  const src = `const u = pg.urlFor({ role: DB_ROLES.app });
    const p = pg.providerUrl; const d = pg.database; const a = pg.auth;
    pg.passwordFor("x"); await pg?.stop(); const h = pg.host; const port = pg.port;`;
  assert.deepEqual(remoteSafetyViolations("x.pg.test.ts", src, FIELDS), []);
});

test("R3 is skipped when no field set is supplied (the brain stays usable without the harness)", () => {
  assert.deepEqual(remoteSafetyViolations("x.test.ts", "pg.whatever", undefined), []);
});

// ── Prose is not code ─────────────────────────────────────────────────────────────────────────
// These files DISCUSS the patterns the guard hunts for. A comment saying "see pg.ts" or "never
// truncate on the provider" must not be a violation — the first cut of this guard flagged three.

test("a comment mentioning pg.<something> is not a reference (the filename pg.ts, notably)", () => {
  const src = `// the remote-path timeouts live in pg.ts, next to pg.providerUrl
    const u = pg.urlFor({ role: DB_ROLES.app });`;
  assert.deepEqual(remoteSafetyViolations("x.test.ts", src, FIELDS), []);
});

test("a comment describing the banned TRUNCATE pattern is not a violation", () => {
  const src = `const admin = createClient(pg.providerUrl);
    /* Do NOT do: admin\`truncate events cascade\` — the provider does not own the tables. */
    await admin\`delete from events\`;`;
  assert.deepEqual(remoteSafetyViolations("x.test.ts", src, FIELDS), []);
});

test("blankComments leaves a URL alone — `https://` is not a line comment", () => {
  const src = `const url = "https://x.test/dest"; // trailing comment`;
  const out = blankComments(src);
  assert.match(out, /https:\/\/x\.test\/dest/);
  assert.doesNotMatch(out, /trailing comment/);
});

test("blankComments preserves line numbers (R2 reports them)", () => {
  const src = "a\n/* two\n   lines */\nb";
  assert.equal(blankComments(src).split("\n").length, src.split("\n").length);
});

// ── R1: TRUNCATE through the provider connection ──────────────────────────────────────────────
// On a managed Postgres (Neon) the provider role is NOT a superuser and does NOT own the tables
// (it holds webhook_owner membership with inherit_option = f), so TRUNCATE → 42501. It DOES have
// BYPASSRLS + DML, which is why `delete from` cleanups are fine and only TRUNCATE breaks.

test("R1 flags a TRUNCATE issued on a provider-url handle (const binding)", () => {
  const src = `const admin = createClient(pg.providerUrl);
    afterEach(async () => { await admin\`truncate events, orgs cascade\`; });`;
  const v = remoteSafetyViolations("x.test.ts", src);
  assert.equal(v.length, 1);
  assert.match(v[0], /truncate/i);
  assert.match(v[0], /admin/);
});

test("R1 flags a TRUNCATE on a handle assigned in beforeAll (bare assignment, module-scope let)", () => {
  const src = `let admin: Sql;
    beforeAll(async () => { admin = createClient(pg.providerUrl); });
    afterEach(async () => { await admin\`truncate delivery_attempts, events cascade\`; });`;
  assert.equal(remoteSafetyViolations("x.test.ts", src).length, 1);
});

test("R1 flags a TRUNCATE issued via .unsafe() on a provider handle", () => {
  const src = `const root = createClient(pg.providerUrl);
    await root.unsafe("truncate events cascade");`;
  assert.equal(remoteSafetyViolations("x.test.ts", src).length, 1);
});

// FAIL CLOSED. The first cut enumerated the handles known to be WRONG, so anything it did not
// recognise — an alias, a handle handed to a helper, a name it had never seen — truncated freely and
// lint stayed green. Requiring the handle to be a known OWNER binding inverts that: unrecognised is
// now a violation, so the guard cannot be walked around by renaming.
test("R1 flags a TRUNCATE on an ALIASED handle (the enumerate-the-bad-ones version missed this)", () => {
  const src = `const admin = createClient(pg.providerUrl);
    const t = admin;
    await t\`truncate events cascade\`;`;
  assert.equal(remoteSafetyViolations("x.test.ts", src).length, 1);
});

test("R1 flags a TRUNCATE on a handle this file never binds at all (e.g. passed in from a helper)", () => {
  const src = `import { cleaner } from "./helpers";
    afterEach(async () => { await cleaner\`truncate events cascade\`; });`;
  assert.equal(remoteSafetyViolations("x.test.ts", src).length, 1);
});

test("R1 allows DELETE FROM on a provider handle — BYPASSRLS + DML both hold on Neon", () => {
  const src = `const admin = createClient(pg.providerUrl);
    afterEach(async () => { await admin\`delete from events\`; });`;
  assert.deepEqual(remoteSafetyViolations("x.test.ts", src), []);
});

test("R1 allows TRUNCATE on the owner handle — both spellings", () => {
  const viaField = `const owner = createClient(pg.ownerUrl);
    afterEach(async () => { await owner\`truncate events, orgs cascade\`; });`;
  const viaUrlFor = `const owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
    afterEach(async () => { await owner\`truncate events, orgs cascade\`; });`;
  assert.deepEqual(remoteSafetyViolations("x.test.ts", viaField), []);
  assert.deepEqual(remoteSafetyViolations("x.test.ts", viaUrlFor), []);
});

test("R1 allows a TRUNCATE the test EXPECTS to be rejected (rls.test.ts asserts audit_log is WORM)", () => {
  const src = `const owner = createClient(pg.ownerUrl);
    await expect(owner\`truncate audit_log\`).rejects.toThrow(/append-only/i);`;
  assert.deepEqual(remoteSafetyViolations("x.test.ts", src), []);
});

// ── R1 generalizes past TRUNCATE to every table-OWNERSHIP DDL ──────────────────────────────────
// TRUNCATE was only the first owner-only statement to reach the nightly. CREATE/DROP TRIGGER,
// CREATE/DROP INDEX, ALTER TABLE and the RLS policy DDL all require OWNERSHIP of the table too, and
// all sailed past the TRUNCATE-only first cut. That is exactly how #637's poison trigger
// (`create trigger … on usage` on the provider handle) reached Neon and failed `42501 permission
// denied for table usage` on BOTH attempts, two nights running — while every OTHER DDL site in the
// suite (org-lifecycle's poison trigger, gin-writeamp's CREATE INDEX, the audit ALTER TABLEs) was
// already correctly on the owner handle.

test("R1 flags a CREATE TRIGGER on a provider handle (the #637 poison-trigger shape)", () => {
  const src = `const admin = createClient(pg.providerUrl);
    await admin\`create trigger tf_poison_637_trg before insert or update on usage
      for each row execute function tf_poison_637()\`;`;
  const v = remoteSafetyViolations("x.test.ts", src);
  assert.equal(v.length, 1);
  assert.match(v[0], /create trigger/i);
  assert.match(v[0], /admin/);
  assert.match(v[0], /owner/i);
});

test("R1 flags CREATE OR REPLACE TRIGGER (PG14+) on a provider handle — the `create trigger` shortcut must not evade it", () => {
  const src = `const admin = createClient(pg.providerUrl);
    await admin\`create or replace trigger t before insert on usage for each row execute function f()\`;`;
  assert.equal(remoteSafetyViolations("x.test.ts", src).length, 1);
});

test("R1 flags a DROP TRIGGER on a provider handle assigned in beforeAll", () => {
  const src = `let admin: Sql;
    beforeAll(async () => { admin = createClient(pg.providerUrl); });
    await admin\`drop trigger tf_poison_637_trg on usage\`;`;
  assert.equal(remoteSafetyViolations("x.test.ts", src).length, 1);
});

test("R1 flags a CREATE INDEX on a provider handle", () => {
  const src = `const admin = createClient(pg.providerUrl);
    await admin\`create index events_headers_trgm on events using gin ((headers::text) gin_trgm_ops)\`;`;
  const v = remoteSafetyViolations("x.test.ts", src);
  assert.equal(v.length, 1);
  assert.match(v[0], /create index/i);
});

test("R1 flags an ALTER TABLE on a provider handle", () => {
  const src = `const admin = createClient(pg.providerUrl);
    await admin\`alter table events disable trigger all\`;`;
  assert.equal(remoteSafetyViolations("x.test.ts", src).length, 1);
});

test("R1 allows the owner-only DDL verbs on the owner handle (org-lifecycle / gin-writeamp shape)", () => {
  const src = `const owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
    await owner\`create trigger tf_poison_635_trg before insert on org_deletions
      for each row execute function tf_poison_635()\`;
    await owner\`drop trigger tf_poison_635_trg on org_deletions\`;
    await owner\`create index events_headers_trgm on events using gin ((headers::text) gin_trgm_ops)\`;
    await owner\`alter table audit_log disable trigger user\`;`;
  assert.deepEqual(remoteSafetyViolations("x.test.ts", src), []);
});

// CREATE/DROP FUNCTION is deliberately NOT owner-only: creating a function needs CREATE on the
// SCHEMA, which the provider role holds on Neon. The proof is #637 itself — its `create or replace
// function tf_poison_637()` on the provider handle SUCCEEDED (the nightly's 42501 was on the next
// line, the `create trigger`). Flagging function DDL would be a false requirement.
test("R1 does NOT flag CREATE/DROP FUNCTION on a provider handle (schema CREATE, not table ownership)", () => {
  const src = `const admin = createClient(pg.providerUrl);
    await admin\`create or replace function tf_poison_637() returns trigger language plpgsql as $$ begin return new; end $$\`;
    await admin\`drop function tf_poison_637()\`;`;
  assert.deepEqual(remoteSafetyViolations("x.test.ts", src), []);
});

// ── R2: seeding a wall-clock rate-limit window with cap-many round-trips ───────────────────────
// audit_log.created_at is stamped now() = the TRANSACTION timestamp. appendAuditEntry costs 3
// round-trips (advisory lock, head read, insert). Looping it cap-many times inside one tx takes
// longer than the limiter's 60s window on a remote DB, so the rows are born already expired and
// the limiter never trips — the test FALSE-PASSES (resolves instead of rejecting).

test("R2 flags a cap-many serial appendAuditEntry loop", () => {
  const src = `await withTenant(app, orgId, async (tx) => {
      for (let i = 0; i < EVENT_DELETE_MAX_PER_WINDOW; i++) {
        await appendAuditEntry(tx, auditKey, { orgId, actor: userActor("u"), action: "event.deleted", target: null });
      }
    });`;
  const v = remoteSafetyViolations("x.test.ts", src);
  assert.equal(v.length, 1);
  assert.match(v[0], /seedAuditChain/);
});

// R2 keys on the loop's BOUND, not on what the body calls. #413's ACTUAL defect was a loop of full
// handler reveals — keying on `appendAuditEntry` would have let that exact shape back in.
test("R2 flags a cap-many loop of HANDLER calls (the original #413 shape, not appendAuditEntry)", () => {
  const src = `for (let i = 0; i < INGEST_URL_REVEAL_MAX_PER_WINDOW; i++) {
      await h(ctx, { endpointId: ep });
    }`;
  assert.equal(remoteSafetyViolations("x.test.ts", src).length, 1);
});

test("R2 flags a loop bounded by a local ALIASED from the cap constant", () => {
  const src = `const cap = EVENT_DELETE_MAX_PER_WINDOW;
    for (let i = 0; i < cap; i++) {
      await deleteEventWithAudit(app, { orgId, eventId }, auditKey);
    }`;
  assert.equal(remoteSafetyViolations("x.test.ts", src).length, 1);
});

test("R2 does not flag a cap-many loop with NO awaited work (no round-trips, no window to outlive)", () => {
  const src = `const rows = [];
    for (let i = 0; i < EVENT_DELETE_MAX_PER_WINDOW; i++) {
      rows.push({ seq: i });
    }`;
  assert.deepEqual(remoteSafetyViolations("x.test.ts", src), []);
});

test("R2 allows the batched seeder (one insert, so the window can't age out)", () => {
  const src = `await withTenant(app, orgId, async (tx) => {
      await seedAuditChain(tx, auditKey, { orgId, actor: userActor("u"), action: "event.deleted", target: null }, EVENT_DELETE_MAX_PER_WINDOW);
    });`;
  assert.deepEqual(remoteSafetyViolations("x.test.ts", src), []);
});

test("R2 allows a small bounded loop that is not cap-many", () => {
  const src = `for (let i = 0; i < 3; i++) {
      await appendAuditEntry(tx, auditKey, entry);
    }`;
  assert.deepEqual(remoteSafetyViolations("x.test.ts", src), []);
});

// ── R5: EXECUTE on an owner-only function through a non-owner handle ───────────────────────────
// The fourth provider-vs-owner incident (#717, 2026-07-21). Postgres grants EXECUTE to PUBLIC by
// default, so every function in the schema is callable by the provider role — EXCEPT one whose
// PUBLIC grant was explicitly REVOKED. `activation_weekly_review()` (0092) is that one, and the
// nightly died on `42501 permission denied for function activation_weekly_review`.
//
// This is NOT DDL, so R1 was structurally blind to it: R1 keys on owner-only DDL VERBS, and this is
// a plain `select fn()`. Measured on the real Neon branch, the provider role
// (`neondb_owner`, pg_has_role USAGE = false / MEMBER = true / set_option = false) has:
//   SELECT/INSERT/UPDATE/DELETE on owner-owned tables = true   (so R1 rightly allows DML)
//   TRUNCATE = false, owner-only DDL = false                    (R1)
//   has_function_privilege('activation_weekly_review()','EXECUTE') = false   (R5)
//
// The owner-only SET IS DERIVED from the migrations — never hand-listed — so a future
// `revoke execute … from public` is covered the day it lands.

test("ownerOnlyFunctions derives the restricted set + its grantees from the REAL migrations", async () => {
  const migrations = await readMigrationSources();
  assert.ok(migrations.length > 90, `expected the migration set, got ${migrations.length}`);
  const acl = ownerOnlyFunctions(migrations.map((m) => m.src));

  // Every function whose PUBLIC execute was revoked, with the roles granted it back. This list is
  // DERIVED, never hand-written: it flipped on its own when 0093 granted the reviewer, and again when
  // 0094 revoked PUBLIC from the three identity definers — which is exactly the property that keeps R5
  // honest as the schema moves.
  assert.deepEqual([...acl.keys()].sort(), [
    "activation_weekly_review",
    "current_user_profile",
    "org_member_directory",
    "user_org_directory",
  ]);
  assert.deepEqual([...acl.get("activation_weekly_review")], ["webhook_activation_reviewer"]);
  // The identity definers stay reachable by the request-path role and nothing else.
  for (const fn of ["current_user_profile", "user_org_directory", "org_member_directory"]) {
    assert.deepEqual([...acl.get(fn)], ["webhook_app"], `unexpected grantees for ${fn}`);
  }
});

test("FLOOR: ownerOnlyFunctions over zero migrations derives nothing (main() must fail closed)", () => {
  assert.equal(ownerOnlyFunctions([]).size, 0);
  assert.equal(ownerOnlyFunctions(["-- revoke execute on function f() from public"]).size, 0);
});

test("dbRoles parses the REAL DB_ROLES (never a hand-maintained role list)", () => {
  const roles = dbRoles(readFileSync(join(ROOT, "packages/db/src/constants.ts"), "utf8"));
  assert.equal(roles.get("owner"), "webhook_owner");
  assert.equal(roles.get("app"), "webhook_app");
  assert.ok(roles.size > 10, `expected the full role map, got ${roles.size}`);
});

const ACL = new Map([["activation_weekly_review", new Set()]]);
const ROLES = new Map([
  ["owner", "webhook_owner"],
  ["app", "webhook_app"],
  ["activationReviewer", "webhook_activation_reviewer"],
]);
const ctx = (extra = {}) => ({ ownerOnly: ACL, roles: ROLES, readers: new Set(), ...extra });

test("R5 flags an owner-only function called on a provider handle (the #717 shape)", () => {
  const src = `const provider = createClient(pg.providerUrl);
    const rows = await provider\`select iso_week from activation_weekly_review() where x = 1\`;`;
  const v = ownerOnlyExecuteViolations("x.test.ts", src, ctx());
  assert.equal(v.length, 1);
  assert.match(v[0], /activation_weekly_review/);
  assert.match(v[0], /provider/);
});

test("R5 flags it on a handle assigned in beforeAll (module-scope let)", () => {
  const src = `let provider: Sql;
    beforeAll(async () => { provider = createClient(pg.providerUrl); });
    await provider\`select * from activation_weekly_review()\`;`;
  assert.equal(ownerOnlyExecuteViolations("x.test.ts", src, ctx()).length, 1);
});

test("R5 FAILS CLOSED on a handle the file never binds (alias, helper-supplied, renamed)", () => {
  const src = `await mystery\`select * from activation_weekly_review()\`;`;
  assert.equal(ownerOnlyExecuteViolations("x.test.ts", src, ctx()).length, 1);
});

test("R5 allows the owner handle — both spellings", () => {
  const viaField = `const owner = createClient(pg.ownerUrl);
    await owner\`select * from activation_weekly_review()\`;`;
  const viaUrlFor = `const owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
    await owner\`select * from activation_weekly_review()\`;`;
  assert.deepEqual(ownerOnlyExecuteViolations("x.test.ts", viaField, ctx()), []);
  assert.deepEqual(ownerOnlyExecuteViolations("x.test.ts", viaUrlFor, ctx()), []);
});

test("R5 allows a call the test EXPECTS to be rejected (the webhook_app denial assertion)", () => {
  const src = `const app = createClient(pg.urlFor({ role: DB_ROLES.app }));
    await expect(app\`select * from activation_weekly_review()\`).rejects.toThrow(/permission denied/i);`;
  assert.deepEqual(ownerOnlyExecuteViolations("x.test.ts", src, ctx()), []);
});

test("R5 does NOT flag a function that keeps its PUBLIC execute (the provider may call it)", () => {
  const src = `const provider = createClient(pg.providerUrl);
    await provider\`select rollup_activation_milestones()\`;`;
  assert.deepEqual(ownerOnlyExecuteViolations("x.test.ts", src, ctx()), []);
});

test("R5 allows a handle bound to a role the migrations GRANTED execute to", () => {
  const granted = new Map([["activation_weekly_review", new Set(["webhook_activation_reviewer"])]]);
  const src = `const reviewer = createClient(pg.urlFor({ role: DB_ROLES.activationReviewer }));
    await reviewer\`select * from activation_weekly_review()\`;`;
  assert.deepEqual(ownerOnlyExecuteViolations("x.test.ts", src, ctx({ ownerOnly: granted })), []);
  // …and still refuses the provider, which holds no grant.
  const bad = `const provider = createClient(pg.providerUrl);
    await provider\`select * from activation_weekly_review()\`;`;
  assert.equal(ownerOnlyExecuteViolations("x.test.ts", bad, ctx({ ownerOnly: granted })).length, 1);
});

test("R5 does not trip on the function name in a comment (blankComments applies)", () => {
  const src = `const provider = createClient(pg.providerUrl);
    // never call activation_weekly_review() on the provider handle
    await provider\`select 1\`;`;
  assert.deepEqual(ownerOnlyExecuteViolations("x.test.ts", src, ctx()), []);
});

// ── R5, one hop: the reader wrapper ───────────────────────────────────────────────────────────
// #717's SECOND failure never named the function in the test at all — it went through
// readActivationWeeklyReview(provider), whose body issues the call. A rule that only reads the test
// file's own SQL misses half the incident, so the reader set is derived from packages/db/src.

test("ownerOnlyReaders finds the REAL wrapper that calls the owner-only function", async () => {
  const sources = await readDbSrcSources();
  assert.ok(sources.length > 5, `expected packages/db/src, got ${sources.length}`);
  const readers = ownerOnlyReaders(sources, ACL);
  assert.ok(
    readers.has("readActivationWeeklyReview"),
    `expected readActivationWeeklyReview, got ${[...readers]}`,
  );
});

test("R5 flags the reader wrapper invoked with a provider handle", () => {
  const src = `const provider = createClient(pg.providerUrl);
    const rows = await readActivationWeeklyReview(provider);`;
  const v = ownerOnlyExecuteViolations(
    "x.test.ts",
    src,
    ctx({
      readers: new Set(["readActivationWeeklyReview"]),
    }),
  );
  assert.equal(v.length, 1);
  assert.match(v[0], /readActivationWeeklyReview/);
});

test("R5 allows the reader wrapper invoked with the owner handle", () => {
  const src = `const owner = createClient(pg.ownerUrl);
    const rows = await readActivationWeeklyReview(owner);`;
  assert.deepEqual(
    ownerOnlyExecuteViolations(
      "x.test.ts",
      src,
      ctx({
        readers: new Set(["readActivationWeeklyReview"]),
      }),
    ),
    [],
  );
});

test("R5 is skipped entirely when no context is supplied (unit cases above stay honest)", () => {
  const src = `const provider = createClient(pg.providerUrl);
    await provider\`select * from activation_weekly_review()\`;`;
  assert.deepEqual(ownerOnlyExecuteViolations("x.test.ts", src, undefined), []);
});

// The assertion that actually blocks the bug. The unit cases above pin the brain's edges; this runs
// the whole derived rule over every real source the nightly executes against Neon.
test("R5: every source the nightly runs holds under the owner-only EXECUTE rule", async () => {
  const [sources, migrations, dbSrc] = await Promise.all([
    readDbTestSources(),
    readMigrationSources(),
    readDbSrcSources(),
  ]);
  const roles = dbRoles(readFileSync(join(ROOT, "packages/db/src/constants.ts"), "utf8"));
  const ownerOnly = ownerOnlyFunctions(migrations.map((m) => m.src));
  const readers = ownerOnlyReaders(dbSrc, ownerOnly);
  // Vacuity checks: a rule that derives an EMPTY owner-only set, or never finds the wrapper, is a
  // no-op that reads as clean — the exact failure mode this repo has been bitten by before.
  assert.ok(ownerOnly.size > 0, "derived no owner-only functions — the rule would be a no-op");
  assert.ok(readers.size > 0, "derived no owner-only wrappers — the one-hop arm would be a no-op");
  assert.ok(sources.length > 40, `expected the db test suite, got ${sources.length}`);
  const violations = sources.flatMap(({ file, src }) =>
    ownerOnlyExecuteViolations(file, src, { ownerOnly, roles, readers }),
  );
  assert.deepEqual(violations, []);
});

test("R5 does not read a wrapper's name out of a describe() TITLE (a string is not a call)", () => {
  // The real shape that tripped the first cut: `describe("readActivationWeeklyReview (typed reader)")`
  // parses as a call to the wrapper with a handle named `typed`.
  const src = `describe("readActivationWeeklyReview (typed reader)", () => {
      it("maps rows", async () => {
        const rows = await readActivationWeeklyReview(owner);
      });
    });
    const owner = createClient(pg.ownerUrl);`;
  assert.deepEqual(
    ownerOnlyExecuteViolations(
      "x.test.ts",
      src,
      ctx({
        readers: new Set(["readActivationWeeklyReview"]),
      }),
    ),
    [],
  );
});

test("blankQuotedStrings preserves offsets and leaves backtick SQL alone", () => {
  const src = `const a = "hello"; await sql\`select 1\`;`;
  const out = blankQuotedStrings(src);
  assert.equal(out.length, src.length);
  assert.doesNotMatch(out, /hello/);
  assert.match(out, /select 1/);
});

test("R5 does not flag INTROSPECTION that names the function in a SQL string literal", () => {
  // has_function_privilege(role, 'fn()', 'EXECUTE') pins the ACL — it does not call the function.
  // Flagging it would block the very test that stops an accidental GRANT to webhook_app.
  const src = `const provider = createClient(pg.providerUrl);
    const [acl] = await provider\`
      select has_function_privilege('webhook_app', 'activation_weekly_review()', 'EXECUTE') as app\`;`;
  assert.deepEqual(ownerOnlyExecuteViolations("x.test.ts", src, ctx()), []);
});

test("R5 still flags a REAL call sitting in the same file as an introspection query", () => {
  const src = `const provider = createClient(pg.providerUrl);
    await provider\`select has_function_privilege('webhook_app', 'activation_weekly_review()', 'EXECUTE')\`;
    await provider\`select * from activation_weekly_review()\`;`;
  assert.equal(ownerOnlyExecuteViolations("x.test.ts", src, ctx()).length, 1);
});

// ── R5 derivation hardening (found by probing the first cut, not by reading it) ────────────────

test("ownerOnlyFunctions IGNORES the migrate:down section (a rollback grant is not a live grant)", () => {
  // Down-section `grant execute` statements really exist (0028, 0030, 0069, 0091 …). Reading them
  // would mark a function reachable by a role that only regains it on ROLLBACK, silently switching
  // the rule off for that function.
  const sql = `revoke execute on function f() from public;
-- migrate:down
grant execute on function f() to webhook_app;`;
  const acl = ownerOnlyFunctions([sql]);
  assert.deepEqual([...acl.keys()], ["f"]);
  assert.deepEqual([...acl.get("f")], [], "a down-section grant must not count as a live grantee");
});

test("ownerOnlyFunctions still reads a LIVE grant in the up section", () => {
  const sql = `revoke execute on function f() from public;
grant execute on function f() to webhook_reviewer;
-- migrate:down
drop function f();`;
  assert.deepEqual([...ownerOnlyFunctions([sql]).get("f")], ["webhook_reviewer"]);
});

test("ownerOnlyFunctions parses every REVOKE spelling Postgres accepts", () => {
  const spellings = [
    ["schema-qualified", `revoke execute on function public.f() from public;`],
    ["no argument list", `revoke execute on function f from public;`],
    ["ROUTINE synonym", `revoke execute on routine f() from public;`],
    ["typed arguments", `revoke execute on function f(date, text) from public;`],
    ["GROUP PUBLIC", `revoke execute on function f() from group public;`],
    ["comma-separated list", `revoke execute on function g(), f(int) from public;`],
  ];
  for (const [label, sql] of spellings) {
    assert.ok(ownerOnlyFunctions([sql]).has("f"), `missed the ${label} spelling: ${sql}`);
  }
});

test("a blanket `revoke … on ALL functions in schema` is UNMODELABLE and must fail closed", () => {
  // The rule maps names to handles; a schema-wide revoke has no name to map, so silently deriving
  // nothing from it would be the worst outcome — a rule that reads as clean.
  const sql = `revoke execute on all functions in schema public from public;`;
  assert.equal(unmodelableExecuteRevokes([sql]).length, 1);
  assert.deepEqual(unmodelableExecuteRevokes([`revoke execute on function f() from public;`]), []);
});

test("readMigrationSources returns ONLY numbered migrations (not .better-auth.schema.sql)", async () => {
  const migrations = await readMigrationSources();
  assert.ok(migrations.length > 90, `expected the migration set, got ${migrations.length}`);
  for (const m of migrations) {
    assert.match(m.file, /\d{4}_[\w-]+\.sql$/, `not a numbered migration: ${m.file}`);
  }
});

// ── R5: a transaction handle INHERITS the role of the connection it came from ──────────────────
// Discovered by running the rule after 0094 revoked PUBLIC from the identity definers: five real,
// correct call sites were flagged because they run on `tx`, a callback parameter, not on a bound
// handle. `app.begin(async (tx) => …)` and the `withTenant`/`withUser` helpers all hand out a
// transaction scoped to the SAME connection — so `tx` is exactly as entitled as `app` is. Failing
// closed on it would push authors to silence the guard, which is worse than the bug it prevents.

test("R5 follows `handle.begin(async (tx) => …)` — tx inherits the connection's role", () => {
  const src = `const app = createClient(pg.urlFor({ role: DB_ROLES.app }));
    const rows = await app.begin(async (tx) => {
      return tx\`select org_id from user_org_directory()\`;
    });`;
  const acl = new Map([["user_org_directory", new Set(["webhook_app"])]]);
  assert.deepEqual(ownerOnlyExecuteViolations("x.test.ts", src, ctx({ ownerOnly: acl })), []);
});

test("R5 follows the withTenant/withUser helpers — tx inherits the handle passed in", () => {
  const src = `const app = createClient(pg.urlFor({ role: DB_ROLES.app }));
    const rows = await withUser(
      app,
      userId,
      (tx) => tx\`select name, email from current_user_profile()\`,
    );`;
  const acl = new Map([["current_user_profile", new Set(["webhook_app"])]]);
  assert.deepEqual(ownerOnlyExecuteViolations("x.test.ts", src, ctx({ ownerOnly: acl })), []);
});

test("R5 STILL flags a tx derived from a handle that is NOT entitled", () => {
  const src = `const provider = createClient(pg.providerUrl);
    await provider.begin(async (tx) => {
      return tx\`select * from activation_weekly_review()\`;
    });`;
  assert.equal(ownerOnlyExecuteViolations("x.test.ts", src, ctx()).length, 1);
});

test("R5 fails closed when the same tx name is derived from CONFLICTING roles in one file", () => {
  // Two different connections both hand their callback a `tx`; we cannot tell which one a given call
  // site belongs to, so the safe answer is "unbound" — i.e. still a violation.
  const src = `const app = createClient(pg.urlFor({ role: DB_ROLES.app }));
    const provider = createClient(pg.providerUrl);
    await app.begin(async (tx) => tx\`select 1\`);
    await provider.begin(async (tx) => {
      return tx\`select * from activation_weekly_review()\`;
    });`;
  assert.equal(ownerOnlyExecuteViolations("x.test.ts", src, ctx()).length, 1);
});

test("R5 exempts a denial test that wraps a whole transaction in expect(...).rejects", () => {
  // The strongest denial test runs the query AS the refused role, so the handle sits many lines inside
  // the expect() argument — not immediately after `expect(`. Flagging it would make the guard punish the
  // very assertion that proves the revoke works.
  const src = `for (const [label, sql] of [["ingest", ingest]]) {
      await expect(
        sql.begin(async (tx) => {
          await tx\`select set_config('app.current_user', 'x', true)\`;
          return tx\`select name, email from current_user_profile()\`;
        }),
        \`\${label} must not reach it\`,
      ).rejects.toThrow(/permission denied for function/i);
    }`;
  const acl = new Map([["current_user_profile", new Set(["webhook_app"])]]);
  assert.deepEqual(ownerOnlyExecuteViolations("x.test.ts", src, ctx({ ownerOnly: acl })), []);
});

test("R5 still flags the SAME shape when it is not asserted to reject", () => {
  const src = `const provider = createClient(pg.providerUrl);
    await provider.begin(async (tx) => {
      return tx\`select * from activation_weekly_review()\`;
    });`;
  assert.equal(ownerOnlyExecuteViolations("x.test.ts", src, ctx()).length, 1);
});
