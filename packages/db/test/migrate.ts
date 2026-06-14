// Test-side migration runner: bootstrap the non-owner ownership model and drive
// dbmate against an ephemeral cluster.
//
// The freeze's RLS guarantees only hold if the table OWNER is a non-superuser
// (a superuser, and a table owner without FORCE RLS, bypass policies). So in tests —
// exactly as in prod — migrations run as a dedicated non-superuser `webhook_owner`
// that owns the schema, and the app/ingest roles created by the migrations are
// separate non-owner roles.
//
// Two auth modes (pg.auth):
//   - "trust": local ephemeral (--auth=trust) or a trust-auth CI service — no passwords.
//   - "password": a managed Postgres (e.g. a Neon branch, M4 nightly) that requires
//     SCRAM. The harness mints per-run, in-memory passwords; we set them on the owner
//     (here) and on the app/ingest roles (applyRolePasswords) so they can log in. The
//     passwords are never written to source and rotate every run.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

import { DB_ROLES } from "../src/constants";
import type { EphemeralPostgres } from "./pg";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join("db", "migrations");

/**
 * Number of dbmate migration files (drives full down/up reversibility). dbmate only
 * treats version-prefixed files as migrations, so reference files like
 * `.better-auth.schema.sql` are excluded by the same leading-digits rule.
 */
export function migrationCount(): number {
  return readdirSync(join(PACKAGE_ROOT, MIGRATIONS_DIR)).filter((f) => /^\d+_.*\.sql$/.test(f))
    .length;
}

// DDL here is built with sql.unsafe() because role/password/database DDL (CREATE ROLE, ALTER ROLE
// ... PASSWORD, GRANT) is a utility statement Postgres will NOT accept bind parameters for — so we
// can't use postgres.js parameterization and must interpolate. The inputs are trusted (role names
// from DB_ROLES, hex passwords minted by the harness), but we still escape them defensively so a
// future value with a quote can't break out: identifiers via quoteIdent, string literals via
// quoteLiteral (the same escaping Postgres' own quote_ident/quote_literal apply).
function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function passwordClause(pg: EphemeralPostgres, role: string): string {
  const pw = pg.passwordFor(role);
  return pw ? ` password ${quoteLiteral(pw)}` : "";
}

/**
 * Create the non-superuser schema owner and hand it the schema. Runs as the provider/
 * superuser. Idempotent. webhook_owner gets CREATEROLE so the migrations can create the
 * app/ingest roles; it is explicitly NOT a superuser and has no BYPASSRLS. In password
 * mode it also gets its per-run login password.
 */
export async function bootstrapOwner(pg: EphemeralPostgres): Promise<void> {
  const sql = postgres(pg.ownerUrl, { max: 1, prepare: false, fetch_types: false });
  try {
    const owner = DB_ROLES.owner;
    const ownerIdent = quoteIdent(owner);
    const ownerPw = pg.passwordFor(owner);
    // Roles are cluster-global, so on a shared server (CI service / a Neon branch)
    // webhook_owner may already exist from a prior test file. Create if missing, then
    // (password mode) ALWAYS reset its password to this run's value — otherwise a
    // stale password from the previous file would make dbmate's owner login fail.
    const resetPw =
      pg.auth === "password" && ownerPw
        ? `alter role ${ownerIdent} login password ${quoteLiteral(ownerPw)};`
        : "";
    await sql.unsafe(`
      do $$
      begin
        if not exists (select 1 from pg_roles where rolname = ${quoteLiteral(owner)}) then
          create role ${ownerIdent} login createrole nosuperuser nobypassrls;
        end if;
      end
      $$;
      ${resetPw}
      grant all on database ${quoteIdent(pg.database)} to ${ownerIdent};
      -- Grant CREATE+USAGE on public rather than transferring schema ownership: on
      -- PG 16+/Neon, ALTER SCHEMA ... OWNER requires SET-ROLE membership the provider
      -- role lacks, and the grant is all webhook_owner needs (tables it creates are
      -- owned by it, so FORCE RLS still polices the owner). Portable across PG 14/17.
      grant all on schema public to ${ownerIdent};
    `);
  } finally {
    await sql.end();
  }
}

/**
 * In password mode, set the per-run login passwords on the non-owner roles the migrations
 * created (app/ingest/authn/anchor — all created password-less so source carries no credentials).
 * Must stay in lockstep with pg.ts MANAGED_ROLES: any role the harness mints a password for AND
 * connects as in a test must also be ALTERed here, or its login fails under SCRAM (Neon nightly).
 * No-op under trust auth. Run as the provider/superuser after the migrations apply.
 */
export async function applyRolePasswords(pg: EphemeralPostgres): Promise<void> {
  if (pg.auth !== "password") return;
  const sql = postgres(pg.ownerUrl, { max: 1, prepare: false, fetch_types: false });
  try {
    for (const role of [DB_ROLES.app, DB_ROLES.ingest, DB_ROLES.authn, DB_ROLES.anchor]) {
      await sql.unsafe(`alter role ${quoteIdent(role)}${passwordClause(pg, role)}`);
    }
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
      // urlFor already carries the owner's password (password mode) + sslmode.
      DATABASE_URL: pg.urlFor({ role: DB_ROLES.owner }),
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

/** Bootstrap ownership, apply all migrations, and (password mode) set role passwords. */
export async function setupSchema(pg: EphemeralPostgres): Promise<void> {
  await bootstrapOwner(pg);
  migrateUp(pg);
  await applyRolePasswords(pg);
}
