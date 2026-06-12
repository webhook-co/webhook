import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { bootstrapOwner, migrateDownAll, migrateUp } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// Migration reversibility (plan "Testing": apply up -> down -> up cleanly in CI).
// A clean down leaves only dbmate's schema_migrations and removes the app/ingest
// roles; a second up re-applies without error (idempotent role creation).

let pg: EphemeralPostgres;
let owner: Sql;

async function publicTables(): Promise<string[]> {
  const rows = await owner<{ relname: string }[]>`
    select relname from pg_class
    where relkind = 'r' and relnamespace = 'public'::regnamespace
    order by relname`;
  return rows.map((r) => r.relname);
}

async function appRoles(): Promise<string[]> {
  const rows = await owner<{ rolname: string }[]>`
    select rolname from pg_roles where rolname in (${DB_ROLES.app}, ${DB_ROLES.ingest})
    order by rolname`;
  return rows.map((r) => r.rolname);
}

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
  it("applies all migrations, creating the domain schema and roles", async () => {
    migrateUp(pg);
    const tables = await publicTables();
    expect(tables).toContain("events");
    expect(tables).toContain("audit_log");
    expect(tables).toContain("schema_migrations");
    expect(await appRoles()).toEqual([DB_ROLES.app, DB_ROLES.ingest]);
  });

  it("rolls every migration back to a clean schema with no leftover roles", async () => {
    migrateDownAll(pg);
    expect(await publicTables()).toEqual(["schema_migrations"]);
    expect(await appRoles()).toEqual([]);
  });

  it("re-applies cleanly after a full rollback (idempotent)", async () => {
    migrateUp(pg);
    const tables = await publicTables();
    expect(tables).toContain("events");
    expect(await appRoles()).toEqual([DB_ROLES.app, DB_ROLES.ingest]);
  });
});
