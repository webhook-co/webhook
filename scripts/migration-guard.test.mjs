import assert from "node:assert/strict";
import { test } from "node:test";

import {
  guardDecision,
  isMigrationName,
  MIGRATION_FILE_RE,
  unappliedMigrations,
} from "./migration-guard.mjs";

// A migration dir entry as getContent returns it: { name, sha }. `sha` is the file's git blob sha.
const m = (name, sha) => ({ name, sha });

test("isMigrationName: a numbered migration file → true", () => {
  assert.equal(isMigrationName("0041_agent_triggers.sql"), true);
  assert.equal(isMigrationName("0042_meter_softcap_enumeration.sql"), true);
});

test("isMigrationName: the schema DUMP / .gitkeep / non-numbered → false (mirrors migrate.ts)", () => {
  assert.equal(isMigrationName(".better-auth.schema.sql"), false);
  assert.equal(isMigrationName(".gitkeep"), false);
  assert.equal(isMigrationName("schema.sql"), false);
  assert.equal(isMigrationName("README.md"), false);
});

test("isMigrationName: non-string → false (never throws)", () => {
  assert.equal(isMigrationName(undefined), false);
  assert.equal(isMigrationName(null), false);
  assert.equal(isMigrationName(42), false);
});

test("MIGRATION_FILE_RE matches only a leading-digits .sql filename", () => {
  assert.match("0001_init.sql", MIGRATION_FILE_RE);
  assert.doesNotMatch(".better-auth.schema.sql", MIGRATION_FILE_RE);
  assert.doesNotMatch("init.sql", MIGRATION_FILE_RE);
});

test("unappliedMigrations: HEAD has a NEW migration prod-schema lacks → returns it", () => {
  const base = [m("0041_a.sql", "sha41"), m("0042_b.sql", "sha42")];
  const head = [m("0041_a.sql", "sha41"), m("0042_b.sql", "sha42"), m("0043_c.sql", "sha43")];
  assert.deepEqual(unappliedMigrations(base, head), ["0043_c.sql"]);
});

test("unappliedMigrations: an EDITED already-applied migration (same name, new sha) → returned", () => {
  const base = [m("0043_c.sql", "shaOLD")];
  const head = [m("0043_c.sql", "shaNEW")]; // body edited in place
  assert.deepEqual(unappliedMigrations(base, head), ["0043_c.sql"]);
});

test("unappliedMigrations: identical (name+sha) sets → none", () => {
  const files = [m("0041_a.sql", "sha41"), m("0042_b.sql", "sha42")];
  assert.deepEqual(unappliedMigrations(files, files), []);
});

test("unappliedMigrations: ignores the schema dump / non-migration entries on both sides", () => {
  const base = [m("0041_a.sql", "s1"), m(".better-auth.schema.sql", "s2"), m(".gitkeep", "s3")];
  const head = [m("0041_a.sql", "s1"), m(".better-auth.schema.sql", "sZ"), m("README.md", "s4")];
  assert.deepEqual(unappliedMigrations(base, head), []); // schema-dump sha change is not a migration
});

test("unappliedMigrations: a HEAD migration entry with a missing/non-string sha → FAIL CLOSED (flagged)", () => {
  assert.deepEqual(unappliedMigrations([], [{ name: "0043_c.sql" }]), ["0043_c.sql"]);
  assert.deepEqual(unappliedMigrations([m("0043_c.sql", "s")], [{ name: "0043_c.sql", sha: 42 }]), [
    "0043_c.sql",
  ]);
});

test("unappliedMigrations: HEAD MISSING a base migration (deletion) is not 'unapplied' → none", () => {
  const base = [m("0041_a.sql", "s1"), m("0042_b.sql", "s2")];
  const head = [m("0041_a.sql", "s1")];
  assert.deepEqual(unappliedMigrations(base, head), []);
});

test("guardDecision: an added migration → block (migration-not-applied) with the names", () => {
  const r = guardDecision([m("0042_b.sql", "s2")], [m("0042_b.sql", "s2"), m("0043_c.sql", "s3")]);
  assert.equal(r.blocked, true);
  assert.equal(r.reason, "migration-not-applied");
  assert.deepEqual(r.migrations, ["0043_c.sql"]);
});

test("guardDecision: no new/edited migration (even a huge unrelated diff) → allow", () => {
  const files = [m("0042_b.sql", "s2")]; // migrations dir unchanged regardless of other file churn
  assert.deepEqual(guardDecision(files, files), {
    blocked: false,
    reason: "no-migration",
    migrations: [],
  });
});

test("guardDecision: a listing that couldn't be enumerated → FAIL CLOSED (inconclusive)", () => {
  assert.deepEqual(guardDecision(undefined, [m("0043_c.sql", "s3")]), {
    blocked: true,
    reason: "inconclusive-listing",
    migrations: [],
  });
  assert.deepEqual(guardDecision([m("0042_b.sql", "s2")], null), {
    blocked: true,
    reason: "inconclusive-listing",
    migrations: [],
  });
});
