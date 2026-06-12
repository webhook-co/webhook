// Test-side migration runner: bootstrap the non-owner ownership model and drive
// dbmate against an ephemeral cluster.
//
// The freeze's RLS guarantees only hold if the table OWNER is a non-superuser
// (a superuser, and a table owner without FORCE RLS, bypass policies). So in tests —
// exactly as in prod — migrations run as a dedicated non-superuser `webhook_owner`
// that owns the schema, and the app/ingest roles created by the migrations are
// separate non-owner roles. Auth is `trust` (local ephemeral via --auth=trust; CI
// via POSTGRES_HOST_AUTH_METHOD=trust), so no passwords are needed or stored.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

import { DB_ROLES } from "../src/constants";
import type { EphemeralPostgres } from "./pg";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join("db", "migrations");

/** Connection URL for dbmate (libpq-style; sslmode=disable for the local/CI cluster). */
function dbmateUrl(pg: EphemeralPostgres, role: string): string {
  return `${pg.urlFor({ role })}?sslmode=disable`;
}

/**
 * Number of dbmate migration files (drives full down/up reversibility). dbmate only
 * treats version-prefixed files as migrations, so reference files like
 * `.better-auth.schema.sql` are excluded by the same leading-digits rule.
 */
export function migrationCount(): number {
  return readdirSync(join(PACKAGE_ROOT, MIGRATIONS_DIR)).filter((f) => /^\d+_.*\.sql$/.test(f))
    .length;
}

/**
 * Create the non-superuser schema owner and hand it the schema. Runs as the cluster
 * superuser. Idempotent. webhook_owner gets CREATEROLE so the migrations can create
 * the app/ingest roles; it is explicitly NOT a superuser and has no BYPASSRLS.
 */
export async function bootstrapOwner(pg: EphemeralPostgres): Promise<void> {
  const sql = postgres(pg.ownerUrl, { max: 1, prepare: false, fetch_types: false });
  try {
    const owner = DB_ROLES.owner;
    await sql.unsafe(`
      do $$
      begin
        if not exists (select 1 from pg_roles where rolname = '${owner}') then
          create role ${owner} login createrole nosuperuser nobypassrls;
        end if;
      end
      $$;
      grant all on database "${pg.database}" to ${owner};
      alter schema public owner to ${owner};
      grant all on schema public to ${owner};
    `);
  } finally {
    await sql.end();
  }
}

function dbmate(pg: EphemeralPostgres, args: string[]): void {
  const res = spawnSync("dbmate", ["--no-dump-schema", ...args], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: dbmateUrl(pg, DB_ROLES.owner),
      DBMATE_MIGRATIONS_DIR: MIGRATIONS_DIR,
    },
  });
  if (res.error) throw new Error(`failed to spawn dbmate: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`dbmate ${args.join(" ")} exited ${res.status}: ${res.stderr || res.stdout}`);
  }
}

/** Apply all pending migrations (no implicit database create). */
export function migrateUp(pg: EphemeralPostgres): void {
  dbmate(pg, ["migrate"]);
}

/** Roll back the most recent migration. */
export function migrateDown(pg: EphemeralPostgres): void {
  dbmate(pg, ["down"]);
}

/** Roll every migration back (one at a time, newest first). */
export function migrateDownAll(pg: EphemeralPostgres): void {
  for (let i = 0; i < migrationCount(); i++) migrateDown(pg);
}

/** Bootstrap ownership and apply all migrations — the standard test setup. */
export async function setupSchema(pg: EphemeralPostgres): Promise<void> {
  await bootstrapOwner(pg);
  migrateUp(pg);
}
