// Docker-free ephemeral Postgres for tests.
//
// This environment has no container runtime but does have a real Homebrew Postgres
// (initdb/pg_ctl/postgres). The RLS leak suite needs a REAL Postgres with REAL
// roles (an in-memory/superuser-only PG would bypass RLS and invalidate the tests),
// so we provision a throwaway cluster per run with the installed binaries.
//
// In CI, set TEST_DATABASE_URL to a Postgres service container and the harness uses
// that instead of spawning a cluster. Both are real Postgres — same intent, no
// shortcut.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import postgres from "postgres";

import { DB_ROLES } from "../src/constants";
import { assertExpectedTestDatabaseHost } from "./expected-host";

export interface RoleUrl {
  role: string;
  database?: string;
}

export interface EphemeralPostgres {
  host: string;
  port: number;
  database: string;
  /**
   * How the created roles authenticate: "trust" (local cluster / a trust-auth CI
   * service — no passwords) or "password" (a managed Postgres like Neon that requires
   * SCRAM). The migrate helper sets per-run passwords on the app/ingest roles in
   * password mode.
   */
  auth: "trust" | "password";
  /**
   * The PROVIDER connection — the role the managed Postgres hands us, NOT the schema owner.
   * It bootstraps the owner + the test DB, and it BYPASSES RLS, which makes it the right handle
   * for a cross-org read or a `delete from` cleanup that must see every tenant's rows.
   *
   * It is a NON-SUPERUSER IN EVERY LANE (#728). On the nightly's Neon branch it is the role the
   * platform hands us (`neondb_owner`); locally and on the trust-auth CI service the harness
   * provisions `test_provider` to match it. It owns NOTHING, so it cannot TRUNCATE, cannot issue
   * owner-only DDL, and cannot EXECUTE a function revoked from PUBLIC: `42501 permission denied …`.
   *
   * That parity is the point. It used to be the `postgres` SUPERUSER locally, which bypasses every
   * ACL check — so the entire historical nightly bug class (#383 TRUNCATE, #637/#688 CREATE TRIGGER,
   * #717 EXECUTE) was structurally invisible until the nightly went red, cron'd for 07:17 UTC but
   * queue-delayed by hours. packages/db/test/provider-fidelity.test.ts now asserts the measured
   * capability table on every PR, in both lanes.
   *
   * For TRUNCATE, use `ownerUrl`. scripts/remote-db-test-guard.mjs (R1/R5) enforces this at lint
   * time too — belt and braces, since a lint rule only knows the shapes it was taught.
   */
  providerUrl: string;
  /** The role `providerUrl` authenticates as — `test_provider` locally, the platform's role remotely. */
  providerRole: string;
  /**
   * The SCHEMA OWNER (`webhook_owner`) — it owns every table, so it is the only role that may
   * TRUNCATE them, in both environments. RLS never filters TRUNCATE, so its FORCE RLS is not in
   * the way. Do NOT reach for it to read or delete ACROSS orgs: it is FORCE-RLS-policed, so
   * without a tenant GUC those silently see zero rows. That is what `providerUrl` is for.
   */
  ownerUrl: string;
  /** A fully-authed connection URL (password + sslmode) for a known role. */
  urlFor: (opts: RoleUrl) => string;
  /** The per-run password for a created role (password mode), else undefined. */
  passwordFor: (role: string) => string | undefined;
  /** Tear down: stop the local cluster, or drop the per-run managed database. */
  stop: () => void | Promise<void>;
}

const SUPERUSER = "postgres";
const DEFAULT_DB = "webhook_test";

/**
 * The non-superuser provider the harness provisions when it is handed a superuser (the local
 * ephemeral cluster, and the trust-auth CI service). Modelled on Neon's `neondb_owner`.
 *
 * DELIBERATELY OUTSIDE the `webhook_` namespace. packages/db/test/migrations.test.ts enumerates
 * every `webhook\_%` role in the cluster and asserts EXACT equality with DB_ROLES-minus-owner —
 * a guard against role drift in the migrations. Naming this `webhook_provider` would break that
 * assertion, and adding an exclusion to keep it quiet would blunt the very guard it exists to be.
 */
const PROVIDER_ROLE = "test_provider";

/**
 * Minimum server major for the lanes the harness provisions itself.
 *
 * PG16 is the real technical floor: from 16, a CREATEROLE non-superuser that CREATES a role is
 * automatically granted it WITH ADMIN OPTION but WITHOUT inherit and WITHOUT set — exactly the
 * `inherit_option = f, set_option = f` shape measured on Neon, for free. On PG14/15 there is no way
 * to hold both `pg_read_all_data` and a non-inheriting `webhook_owner` membership: inheriting the
 * owner makes TRUNCATE and ALTER TABLE SUCCEED (papering the bug class straight back over), and
 * NOINHERIT kills the predefined data roles too, so the provider cannot read at all.
 *
 * We require 17 rather than 16 so the local lane matches CI and both Neon projects exactly.
 */
const MIN_SERVER_MAJOR = 17;

/**
 * Roles the harness provisions credentials for in password mode.
 *
 * DERIVED from DB_ROLES on purpose: a hand-maintained list silently omitted two roles added by
 * later migrations, so their connection URLs carried a password the role never had and every
 * connection failed `28P01` — but only in password mode (the Neon nightly), since trust auth
 * ignores passwords. Deriving makes a new DB_ROLES entry impossible to forget.
 */
export const MANAGED_ROLES: readonly string[] = Object.values(DB_ROLES);

/**
 * Well-known install prefixes to try when whatever `initdb` is on PATH is too old. Homebrew keeps
 * every major side by side and only LINKS one, so a machine can have PG17 installed and still
 * resolve `initdb` to PG14 — which would silently leave the local lane on the old engine while CI
 * moved to 17, exactly the divergence #728 exists to remove.
 */
const PG_BIN_CANDIDATES: readonly string[] = [
  "/opt/homebrew/opt/postgresql@17/bin",
  "/usr/local/opt/postgresql@17/bin",
  "/usr/lib/postgresql/17/bin",
  "/usr/pgsql-17/bin",
];

/** Major version from `initdb --version` output ("initdb (PostgreSQL) 17.10 (Homebrew)" -> 17). */
export function parsePgMajor(versionOutput: string): number | null {
  const m = /\(PostgreSQL\)\s+(\d+)/.exec(versionOutput);
  return m ? Number(m[1]) : null;
}

/**
 * Pick the first candidate bin dir whose server major is at least `min`. Pure — `majorOf` is
 * injected so the choice is unit-testable without a Postgres install.
 *
 * "" means "whatever is on PATH", and it is tried FIRST so a correctly-linked machine needs no
 * special casing.
 */
export function pickPgBinDir(
  candidates: readonly string[],
  majorOf: (dir: string) => number | null,
  min: number = MIN_SERVER_MAJOR,
): string | null {
  for (const dir of candidates) {
    const major = majorOf(dir);
    if (major !== null && major >= min) return dir;
  }
  return null;
}

let resolvedBinDir: string | null | undefined;

/** The bin dir every local Postgres binary is spawned from. Resolved once, then memoised. */
function pgBinDir(): string {
  if (resolvedBinDir !== undefined) {
    if (resolvedBinDir === null) throw new Error(pgVersionErrorMessage());
    return resolvedBinDir;
  }
  const override = process.env.TEST_PG_BINDIR;
  const candidates = override ? [override] : ["", ...PG_BIN_CANDIDATES];
  resolvedBinDir = pickPgBinDir(candidates, (dir) => {
    const res = spawnSync(join(dir, "initdb") || "initdb", ["--version"], { encoding: "utf8" });
    return res.status === 0 ? parsePgMajor(res.stdout) : null;
  });
  if (resolvedBinDir === null) throw new Error(pgVersionErrorMessage());
  return resolvedBinDir;
}

function pgVersionErrorMessage(): string {
  return (
    `could not find a PostgreSQL ${MIN_SERVER_MAJOR}+ installation. The test harness models the ` +
    `managed engine's NON-SUPERUSER provider role, which needs PG16+ role-membership semantics ` +
    `(\`WITH INHERIT FALSE, SET FALSE\`) — on an older server the provider would inherit the schema ` +
    `owner and silently regain every privilege this suite exists to prove it lacks.\n\n` +
    `Install it (macOS: \`brew install postgresql@${MIN_SERVER_MAJOR}\`), or point TEST_PG_BINDIR at ` +
    `an existing install's bin directory. Tried: ` +
    `${(process.env.TEST_PG_BINDIR ? [process.env.TEST_PG_BINDIR] : ["$PATH", ...PG_BIN_CANDIDATES]).join(", ")}.`
  );
}

function serverTooOldMessage(major: number): string {
  return (
    `the Postgres at TEST_DATABASE_URL is major ${major}, but this harness needs ` +
    `${MIN_SERVER_MAJOR}+. It models the managed engine's NON-SUPERUSER provider role, which relies ` +
    `on PG16+ role-membership semantics; on an older server the provider would inherit the schema ` +
    `owner and silently regain every privilege the suite exists to prove it lacks. Point ` +
    `TEST_DATABASE_URL at a PostgreSQL ${MIN_SERVER_MAJOR} service (CI uses \`postgres:17\`).`
  );
}

/** The resolved bin dir, for tests that must spawn a cluster of their own (password-mode.test.ts
 *  needs a SCRAM cluster, which the harness's own trust-auth path cannot provide). */
export function pgBinDirForTests(): string {
  return pgBinDir();
}

/** Spawn a Postgres binary from the resolved bin dir (never bare PATH — see pgBinDir). */
function pgRun(cmd: string, args: string[]): void {
  run(join(pgBinDir(), cmd), args);
}

/**
 * SQL that provisions the non-superuser provider, measured against Neon's `neondb_owner`.
 *
 * - `createrole` is REQUIRED and is missing from the shape originally proposed in #728: the very
 *   first thing bootstrapOwner() does is `create role webhook_owner`, which fails with
 *   "permission denied to create role" without it. Neon's provider has it too (via neon_superuser).
 * - `createdb` is required because the per-file test database must be created BY the provider —
 *   see createDatabaseAsProvider below.
 * - `pg_read_all_data` / `pg_write_all_data` give DML on tables it does not own, matching the
 *   measured Neon capability table.
 * - NOTHING here grants webhook_owner. That membership is created implicitly when this role later
 *   CREATEs webhook_owner, and on PG16+ that automatic self-grant carries ADMIN OPTION but neither
 *   INHERIT nor SET — the exact `inherit_option = f, set_option = f` shape Neon has. Granting it
 *   explicitly with INHERIT would hand back ownership rights and defeat the entire exercise.
 */
function provisionProviderSql(password?: string): string {
  // On a SCRAM cluster the provisioned provider needs a login password like every other role — and
  // it is DELIBERATELY not in DB_ROLES (managed-roles.test.ts pins MANAGED_ROLES === DB_ROLES, and
  // applyRolePasswords connects AS this role, so it cannot be in that loop). Without this, the
  // README's own local password-mode recipe dies `28P01` before the first migration.
  //
  // Set UNCONDITIONALLY, outside the `if not exists` guard: the role is CLUSTER-GLOBAL, so one left
  // behind by a previous run still carries that run's password. Same reason bootstrapOwner resets
  // the owner's password every time.
  const setPassword = password
    ? `alter role "${PROVIDER_ROLE}" login password '${password.replace(/'/g, "''")}';`
    : "";
  return `
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = '${PROVIDER_ROLE}') then
        create role "${PROVIDER_ROLE}" login nosuperuser nobypassrls createdb createrole;
      end if;
    end
    $$;
    alter role "${PROVIDER_ROLE}" bypassrls;
    grant pg_read_all_data, pg_write_all_data to "${PROVIDER_ROLE}";
    ${setPassword}
  `;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not acquire a free port")));
      }
    });
  });
}

function run(cmd: string, args: string[]): void {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.error) {
    throw new Error(`failed to spawn ${cmd}: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${res.status}: ${res.stderr || res.stdout}`);
  }
}

async function waitReady(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = spawnSync(join(pgBinDir(), "pg_isready"), ["-h", host, "-p", String(port), "-q"], {
      encoding: "utf8",
    });
    if (res.status === 0) return;
    if (Date.now() > deadline) {
      throw new Error(`postgres on ${host}:${port} did not become ready within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function buildUrl(
  host: string,
  port: number,
  role: string,
  password: string | undefined,
  database: string,
  sslmode: string,
): string {
  const auth = password === undefined ? role : `${role}:${encodeURIComponent(password)}`;
  return `postgres://${auth}@${host}:${port}/${database}?sslmode=${sslmode}`;
}

/**
 * Provision (or attach to) a Postgres for tests and return connection details +
 * a `stop()` that tears it down. If TEST_DATABASE_URL is set, attach to it (CI);
 * otherwise spawn a throwaway local cluster.
 */
export async function startEphemeralPostgres(): Promise<EphemeralPostgres> {
  const provided = process.env.TEST_DATABASE_URL;
  if (provided && provided.trim() !== "") {
    // FIRST, before anything reads or mutates the target: prove it is the cluster we were told to
    // expect. Everything below this line is destructive on a shared server — the `create database`
    // a few lines down, then the cluster-global role-password rotation in migrate.ts, then the
    // globalSetup sweep's `DROP DATABASE … WITH (FORCE)`. A no-op for the local/trust-auth lanes.
    // scripts/remote-db-test-guard.mjs (R6) pins this call AND its position.
    assertExpectedTestDatabaseHost(provided);

    // Attach to a shared/managed Postgres (a trust-auth CI service OR a managed DB like
    // a Neon branch) and create a UNIQUE database per call so each serial test file is
    // isolated, just like the per-file local clusters. Auth is auto-detected from the
    // provided URL: a password (e.g. Neon) -> password mode (per-run SCRAM passwords
    // for the created roles, sslmode=require); none -> trust mode (CI service).
    const base = new URL(provided);
    const host = base.hostname;
    const port = Number(base.port || "5432");
    const superRole = decodeURIComponent(base.username) || SUPERUSER;
    const superPassword = base.password ? decodeURIComponent(base.password) : undefined;
    const auth: "trust" | "password" = superPassword ? "password" : "trust";
    const sslmode =
      base.searchParams.get("sslmode") ?? (auth === "password" ? "require" : "disable");
    const maintenanceDb = base.pathname.replace(/^\//, "") || "postgres";
    const database = `${DEFAULT_DB}_${randomBytes(6).toString("hex")}`;

    // Per-run, in-memory passwords for the created roles (password mode only). Never
    // stored in source; rotated every run.
    //
    // ⚠️ Postgres ROLES ARE CLUSTER-GLOBAL — they are NOT scoped to the per-file database created
    // below. So every caller of this function ALTERs the passwords of the same shared roles on the
    // Neon branch. Two things that provision concurrently therefore invalidate each other's
    // credentials mid-run, and the loser dies on `password authentication failed for user '…'` —
    // a failure that has nothing to do with the code under test.
    //
    // Everything that runs against the branch must therefore be SERIALIZED. That is why the root
    // `test:db` script chains packages/db with `&&` and passes `--concurrency=1` to the apps' turbo
    // task (they would otherwise run in parallel and race), why vitest sets `fileParallelism: false`
    // in all three configs, and why you must not run a local TEST_DATABASE_URL suite while a
    // `nightly-rls` run is in flight. scripts/remote-db-test-guard.mjs pins the `--concurrency=1`.
    const passwords: Record<string, string> = {};
    // eslint-disable-next-line security/detect-possible-timing-attacks -- not a credential compare; this branches on the connection auth MODE
    if (auth === "password") {
      for (const role of MANAGED_ROLES) passwords[role] = randomBytes(18).toString("hex");
      // The provisioned provider is not in MANAGED_ROLES on purpose (see provisionProviderSql), but
      // it still has to be able to log in — urlFor reads this map for every role.
      passwords[PROVIDER_ROLE] = randomBytes(18).toString("hex");
    }
    const passwordFor = (role: string) => passwords[role];
    const urlFor = ({ role, database: db = database }: RoleUrl) =>
      buildUrl(host, port, role, role === superRole ? superPassword : passwords[role], db, sslmode);

    // Is the role we were handed a SUPERUSER? Two very different situations share this branch:
    //
    //   - the trust-auth CI service, which hands us `postgres` — a superuser that bypasses every ACL
    //     check, and therefore cannot model the managed engine at all;
    //   - the nightly's Neon branch, which hands us a non-superuser (`neondb_owner`) that already IS
    //     the shape we want to test against.
    //
    // So: ask, rather than assume. If we were given a superuser we provision `test_provider` and use
    // that instead; if we were given a non-superuser we leave it exactly alone.
    const admin = postgres(provided, { max: 1, prepare: false, fetch_types: false });
    let providerRole = superRole;
    try {
      const [{ rolsuper }] = await admin<{ rolsuper: boolean }[]>`
        select rolsuper from pg_roles where rolname = current_user`;
      if (rolsuper) {
        const [{ major }] = await admin<{ major: number }[]>`
          select (current_setting('server_version_num')::int / 10000) as major`;
        if (major < MIN_SERVER_MAJOR) throw new Error(serverTooOldMessage(major));
        await admin.unsafe(provisionProviderSql(passwords[PROVIDER_ROLE]));
        providerRole = PROVIDER_ROLE;
      }
    } finally {
      await admin.end();
    }

    // The PROVIDER creates the per-file database, so it OWNS it. That ownership is load-bearing:
    // `public` is owned by `pg_database_owner` from PG15 on, and bootstrapOwner's
    // `grant all on schema public` is a SILENT NO-OP (a WARNING, which postgres.js does not reject)
    // unless the grantor owns the schema — after which webhook_owner cannot create a single table.
    // This is also what the nightly already does, since Neon hands us the database owner.
    const creatorUrl =
      providerRole === superRole
        ? provided
        : buildUrl(host, port, providerRole, passwords[providerRole], maintenanceDb, sslmode);
    const creator = postgres(creatorUrl, { max: 1, prepare: false, fetch_types: false });
    try {
      await creator.unsafe(`create database "${database}"`);
    } finally {
      await creator.end();
    }

    return {
      host,
      port,
      database,
      auth,
      passwordFor,
      providerRole,
      providerUrl: urlFor({ role: providerRole }),
      ownerUrl: urlFor({ role: DB_ROLES.owner }),
      urlFor,
      stop: async () => {
        const adm = postgres(
          buildUrl(host, port, superRole, superPassword, maintenanceDb, sslmode),
          {
            max: 1,
            prepare: false,
            fetch_types: false,
          },
        );
        try {
          await adm.unsafe(`drop database if exists "${database}" with (force)`);
        } finally {
          await adm.end();
        }
      },
    };
  }

  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), "wh-pgtest-"));

  pgRun("initdb", [
    "-D",
    dataDir,
    "-U",
    SUPERUSER,
    "--auth=trust",
    "--encoding=UTF8",
    "--no-locale",
  ]);

  // Put runtime params in postgresql.conf so pg_ctl's `-w` readiness poll targets
  // the right port/socket. (Passing them via `-o` makes pg_ctl poll the default
  // port and hang.) fsync off: throwaway cluster, trade durability for speed.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- dataDir is a mkdtemp() path we created, not user input
  appendFileSync(
    join(dataDir, "postgresql.conf"),
    [
      `port = ${port}`,
      `listen_addresses = '127.0.0.1'`,
      `fsync = off`,
      `synchronous_commit = off`,
      `full_page_writes = off`,
      "",
    ].join("\n"),
  );

  const host = "127.0.0.1";
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      // -W: don't wait via pg_ctl's own ping (unreliable with a custom port on
      // this build). Immediate shutdown is fast; we remove the data dir regardless.
      pgRun("pg_ctl", ["-D", dataDir, "-m", "immediate", "-W", "stop"]);
    } catch {
      // best-effort shutdown; still remove the data dir
    } finally {
      // Best-effort cleanup: `-W` returns before the exiting postmaster releases the data
      // dir, so on some platforms (macOS, under cumulative load) rmSync races it and throws
      // EBUSY/ENOTEMPTY. A throwaway temp dir the OS will reap is not worth failing the suite
      // teardown over (which would mark a file failed despite all tests passing) — swallow it.
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // leaked temp dir is reaped by the OS; never fail teardown on cleanup
      }
    }
  };

  try {
    // -l: redirect server output to a logfile. Without it the postmaster inherits
    // spawnSync's stdout pipe and keeps it open, so spawnSync blocks forever
    // waiting for EOF. -W: don't use pg_ctl's internal wait; we poll readiness.
    pgRun("pg_ctl", ["-D", dataDir, "-l", join(dataDir, "server.log"), "-W", "start"]);
    await waitReady(host, port, 30_000);
    // The provider — NOT the superuser — creates the database. It must OWN it: `public` is owned
    // by `pg_database_owner` on PG15+, and bootstrapOwner's `grant all on schema public` is a
    // SILENT NO-OP (a WARNING, which postgres.js does not reject) when the grantor does not own it.
    // webhook_owner would then be unable to create a single table.
    pgRun("psql", [
      "-h",
      host,
      "-p",
      String(port),
      "-U",
      SUPERUSER,
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
      "-c",
      provisionProviderSql(),
    ]);
    pgRun("createdb", ["-h", host, "-p", String(port), "-U", PROVIDER_ROLE, DEFAULT_DB]);
  } catch (err) {
    // Read the postmaster's log BEFORE stop() removes the data dir. Without this a failed start is an
    // opaque `pg_ctl exited 1`, which is exactly the case a version-skewed or permission-blocked
    // install produces — the one this file's version floor exists to make legible.
    let tail = "";
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- dataDir is our own mkdtemp() path
      tail = readFileSync(join(dataDir, "server.log"), "utf8").split("\n").slice(-20).join("\n");
    } catch {
      // the postmaster never got far enough to write one
    }
    stop();
    if (!tail) throw err;
    throw new Error(`${(err as Error).message}\n--- server.log (last 20 lines) ---\n${tail}`, {
      cause: err,
    });
  }

  return {
    host,
    port,
    database: DEFAULT_DB,
    auth: "trust",
    passwordFor: () => undefined,
    providerRole: PROVIDER_ROLE,
    providerUrl: buildUrl(host, port, PROVIDER_ROLE, undefined, DEFAULT_DB, "disable"),
    ownerUrl: buildUrl(host, port, DB_ROLES.owner, undefined, DEFAULT_DB, "disable"),
    urlFor: ({ role, database = DEFAULT_DB }) =>
      buildUrl(host, port, role, undefined, database, "disable"),
    stop,
  };
}
