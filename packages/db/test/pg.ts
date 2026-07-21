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
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
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
   * It is NOT a superuser on the nightly's Neon branch (there it is `neondb_owner`, holding
   * webhook_owner membership with inherit_option = f), so it owns NOTHING and cannot TRUNCATE:
   * `42501 permission denied for table …`. Locally it IS the postgres superuser, so that mistake
   * passes every local run and only breaks on the NIGHTLY — which is precisely what happened (#383).
   * (That nightly is cron'd for 07:17 UTC, but GitHub queue-delays scheduled runs and a single run
   * has taken ~4h, so no clock-derived assumption about when it lands is sound.)
   * For TRUNCATE, use `ownerUrl`. scripts/remote-db-test-guard.mjs enforces this.
   */
  providerUrl: string;
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
 * Roles the harness provisions credentials for in password mode.
 *
 * DERIVED from DB_ROLES on purpose: a hand-maintained list silently omitted two roles added by
 * later migrations, so their connection URLs carried a password the role never had and every
 * connection failed `28P01` — but only in password mode (the Neon nightly), since trust auth
 * ignores passwords. Deriving makes a new DB_ROLES entry impossible to forget.
 */
export const MANAGED_ROLES: readonly string[] = Object.values(DB_ROLES);

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
    const res = spawnSync("pg_isready", ["-h", host, "-p", String(port), "-q"], {
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
    }
    const passwordFor = (role: string) => passwords[role];
    const urlFor = ({ role, database: db = database }: RoleUrl) =>
      buildUrl(host, port, role, role === superRole ? superPassword : passwords[role], db, sslmode);

    const admin = postgres(provided, { max: 1, prepare: false, fetch_types: false });
    try {
      await admin.unsafe(`create database "${database}"`);
    } finally {
      await admin.end();
    }

    return {
      host,
      port,
      database,
      auth,
      passwordFor,
      providerUrl: urlFor({ role: superRole }),
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

  run("initdb", ["-D", dataDir, "-U", SUPERUSER, "--auth=trust", "--encoding=UTF8", "--no-locale"]);

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
      run("pg_ctl", ["-D", dataDir, "-m", "immediate", "-W", "stop"]);
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
    run("pg_ctl", ["-D", dataDir, "-l", join(dataDir, "server.log"), "-W", "start"]);
    await waitReady(host, port, 30_000);
    run("createdb", ["-h", host, "-p", String(port), "-U", SUPERUSER, DEFAULT_DB]);
  } catch (err) {
    stop();
    throw err;
  }

  return {
    host,
    port,
    database: DEFAULT_DB,
    auth: "trust",
    passwordFor: () => undefined,
    providerUrl: buildUrl(host, port, SUPERUSER, undefined, DEFAULT_DB, "disable"),
    ownerUrl: buildUrl(host, port, DB_ROLES.owner, undefined, DEFAULT_DB, "disable"),
    urlFor: ({ role, database = DEFAULT_DB }) =>
      buildUrl(host, port, role, undefined, database, "disable"),
    stop,
  };
}
