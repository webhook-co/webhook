import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DB_TEST_GLOB,
  readDbTestSources,
  remoteSafetyViolations,
} from "./remote-db-test-guard.mjs";

// The guard running against PRODUCTION: the real, committed packages/db test sources. This is the
// assertion that actually blocks the bug — the unit cases below only pin the brain's edges.
test("the real packages/db test suite is remote-safe (no violations on the committed sources)", async () => {
  const sources = await readDbTestSources();
  // Vacuity check: a glob that matches nothing would make every assertion below trivially true.
  assert.ok(sources.length > 40, `expected the db test suite, got ${sources.length} files`);
  const violations = sources.flatMap(({ file, src }) => remoteSafetyViolations(file, src));
  assert.deepEqual(violations, []);
});

test("DB_TEST_GLOB points at the suite the nightly runs", () => {
  assert.match(DB_TEST_GLOB, /packages\/db\/test/);
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

test("R1 allows DELETE FROM on a provider handle — BYPASSRLS + DML both hold on Neon", () => {
  const src = `const admin = createClient(pg.providerUrl);
    afterEach(async () => { await admin\`delete from events\`; });`;
  assert.deepEqual(remoteSafetyViolations("x.test.ts", src), []);
});

test("R1 allows TRUNCATE on the webhook_owner handle — it owns the tables, and RLS never filters TRUNCATE", () => {
  const src = `const owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
    afterEach(async () => { await owner\`truncate events, orgs cascade\`; });`;
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
