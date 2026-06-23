import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { bootstrapOwner, migrateDownAll, migrateUp, migrationCount } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// Migration reversibility (plan "Testing": apply up -> down -> up cleanly in CI).
// A clean down leaves only dbmate's schema_migrations and removes the created non-owner
// roles (app/ingest/authn/auth); a second up re-applies without error (idempotent role creation).

// Per-test budget for the up/down reversibility runs. migrateDownAll spawns one `dbmate down` — a
// FRESH database connection — per migration, so its cost is O(migrations) in connection setups. On
// the nightly Neon path (TLS + SCRAM handshake per connect over the network) that scales past the
// default 30s as migrations accumulate, false-timing-out a rollback that is correct, just slow (local
// ephemeral PG runs the whole file in ~1s — this budget only bites on Neon). Size it to the work, so
// it auto-scales with the migration count instead of needing a bump every few migrations.
const REVERSIBILITY_TIMEOUT_MS = migrationCount() * 6_000 + 30_000;

let pg: EphemeralPostgres;
let owner: Sql;

async function publicTables(): Promise<string[]> {
  const rows = await owner<{ relname: string }[]>`
    select relname from pg_class
    where relkind = 'r' and relnamespace = 'public'::regnamespace
    order by relname`;
  return rows.map((r) => r.relname);
}

// EVERY non-owner role the migrations create — app/ingest (0002), authn (0008), anchor (0010),
// auth (0016), sweeper (0020). The list must stay complete: a down() that forgets to drop one is
// only caught if that role is checked here (else the down-all clean-schema assertion passes blind).
const MIGRATION_ROLES = [
  DB_ROLES.app,
  DB_ROLES.ingest,
  DB_ROLES.authn,
  DB_ROLES.anchor,
  DB_ROLES.auth,
  DB_ROLES.sweeper,
];

async function appRoles(): Promise<string[]> {
  const rows = await owner<{ rolname: string }[]>`
    select rolname from pg_roles
    where rolname in ${owner(MIGRATION_ROLES)}
    order by rolname`;
  return rows.map((r) => r.rolname);
}

/** The migration roles, sorted by name — the expected appRoles() after a full migrateUp. */
const ALL_ROLES_SORTED = [...MIGRATION_ROLES].sort();

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await bootstrapOwner(pg);
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
}, 90_000);

afterAll(async () => {
  await owner?.end();
  await pg?.stop();
});

describe("migration reversibility (up -> down -> up)", () => {
  it(
    "applies all migrations, creating the domain schema and roles",
    async () => {
      migrateUp(pg);
      const tables = await publicTables();
      expect(tables).toContain("events");
      expect(tables).toContain("audit_log");
      expect(tables).toContain("schema_migrations");
      expect(await appRoles()).toEqual(ALL_ROLES_SORTED);
    },
    REVERSIBILITY_TIMEOUT_MS,
  );

  it(
    "rolls every migration back to a clean schema with no leftover roles",
    async () => {
      migrateDownAll(pg);
      expect(await publicTables()).toEqual(["schema_migrations"]);
      expect(await appRoles()).toEqual([]);
    },
    REVERSIBILITY_TIMEOUT_MS,
  );

  it(
    "re-applies cleanly after a full rollback (idempotent)",
    async () => {
      migrateUp(pg);
      const tables = await publicTables();
      expect(tables).toContain("events");
      expect(await appRoles()).toEqual(ALL_ROLES_SORTED);
    },
    REVERSIBILITY_TIMEOUT_MS,
  );
});
