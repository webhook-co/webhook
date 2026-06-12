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

export interface RoleUrl {
  role?: string;
  password?: string;
  database?: string;
}

export interface EphemeralPostgres {
  host: string;
  port: number;
  database: string;
  /** Superuser URL — used to bootstrap the schema owner and (in CI) the test DB. */
  ownerUrl: string;
  /** Build a connection URL for an arbitrary role/database on this cluster. */
  urlFor: (opts: RoleUrl) => string;
  /** Tear down: stop the local cluster, or drop the per-run CI database. */
  stop: () => void | Promise<void>;
}

const SUPERUSER = "postgres";
const DEFAULT_DB = "webhook_test";

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
  { role = SUPERUSER, password, database = DEFAULT_DB }: RoleUrl,
): string {
  const auth = password === undefined ? role : `${role}:${encodeURIComponent(password)}`;
  return `postgres://${auth}@${host}:${port}/${database}`;
}

/**
 * Provision (or attach to) a Postgres for tests and return connection details +
 * a `stop()` that tears it down. If TEST_DATABASE_URL is set, attach to it (CI);
 * otherwise spawn a throwaway local cluster.
 */
export async function startEphemeralPostgres(): Promise<EphemeralPostgres> {
  const provided = process.env.TEST_DATABASE_URL;
  if (provided && provided.trim() !== "") {
    // CI: attach to a shared Postgres service (POSTGRES_HOST_AUTH_METHOD=trust) but
    // create a UNIQUE database per call so each serial test file is isolated, exactly
    // like the per-file local clusters. The service's superuser owns the create/drop;
    // every role connects password-less via trust.
    const base = new URL(provided);
    const host = base.hostname;
    const port = Number(base.port || "5432");
    const superRole = decodeURIComponent(base.username) || SUPERUSER;
    const maintenanceDb = base.pathname.replace(/^\//, "") || "postgres";
    const database = `${DEFAULT_DB}_${randomBytes(6).toString("hex")}`;

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
      ownerUrl: buildUrl(host, port, { role: superRole, database }),
      urlFor: (opts) => buildUrl(host, port, { role: superRole, database, ...opts }),
      stop: async () => {
        const adm = postgres(buildUrl(host, port, { role: superRole, database: maintenanceDb }), {
          max: 1,
          prepare: false,
          fetch_types: false,
        });
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
      rmSync(dataDir, { recursive: true, force: true });
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
    ownerUrl: buildUrl(host, port, {}),
    urlFor: (opts) => buildUrl(host, port, opts),
    stop,
  };
}
