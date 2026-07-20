import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  blankComments,
  harnessFields,
  readDbTestSources,
  remoteSafetyViolations,
  testDbSerializationViolations,
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
