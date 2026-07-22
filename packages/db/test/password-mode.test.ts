// The PASSWORD-auth lane, end to end (#728 follow-up).
//
// The harness has three lanes and CI only exercises two of them:
//
//   trust-auth CI service ...... covered by the `test-db` job
//   Neon (non-superuser) ....... covered by the nightly
//   password-auth SUPERUSER .... covered by NOTHING — and it is the one packages/db/README.md tells
//                                you to use to validate password mode locally
//
// That gap shipped a real bug. When the harness is handed a superuser it provisions `test_provider`
// and connects as it, but per-run passwords were minted only for MANAGED_ROLES (= DB_ROLES), and
// `test_provider` is deliberately outside that set — so on a SCRAM cluster its connection URL carried
// no password and the run died `28P01 password authentication failed for user "test_provider"`
// before the first migration. Two independent reviews found it; neither CI lane could.
//
// This spins a real SCRAM cluster (a few seconds) rather than mocking, because the thing under test
// IS the authentication handshake — a mock would assert the bug back into existence.

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, type Sql } from "../src/client";
import {
  hasLocalPostgresBinaries,
  pgBinDirForTests,
  provisionProviderSql,
  startEphemeralPostgres,
  type EphemeralPostgres,
} from "./pg";

// Runs in EVERY lane, including CI's service-container job, which has a postgres service but no
// local binaries to spawn a cluster with. These pin the regression itself — a provisioned provider
// with no credential — independently of whether this machine can perform the handshake.
describe("the provisioned provider is given a credential in password mode", () => {
  it("emits an ALTER ROLE … PASSWORD when a password is supplied", () => {
    const sql = provisionProviderSql("hunter2");
    expect(sql).toMatch(/alter role "test_provider" login password 'hunter2'/i);
  });

  it("emits NO password clause under trust auth, where roles have none", () => {
    expect(provisionProviderSql()).not.toMatch(/password/i);
  });

  it("escapes a quote rather than breaking out of the literal", () => {
    expect(provisionProviderSql("a'b")).toContain("'a''b'");
  });

  it("sets the password OUTSIDE the if-not-exists guard, so a stale role is re-credentialed", () => {
    // The role is cluster-global and outlives a test file: one left behind by a previous run still
    // carries THAT run's password. Same reason bootstrapOwner resets the owner's every time.
    const sql = provisionProviderSql("pw");
    expect(sql.indexOf("alter role")).toBeGreaterThan(sql.indexOf("end\n    $$;"));
  });
});

const SUPER_PASSWORD = "harness-scram-probe-pw";

let dataDir: string;
let port: number;
let pg: EphemeralPostgres | undefined;
let provider: Sql | undefined;
const priorUrl = process.env.TEST_DATABASE_URL;

function freePortSync(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") srv.close(() => resolve(addr.port));
      else srv.close(() => reject(new Error("no free port")));
    });
  });
}

function run(cmd: string, args: string[]): void {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`${cmd} exited ${res.status}: ${res.stderr || res.stdout}`);
}

beforeAll(async () => {
  if (!hasLocalPostgresBinaries()) return;
  const bin = pgBinDirForTests();
  dataDir = mkdtempSync(join(tmpdir(), "wh-scram-"));
  port = await freePortSync();

  // A SCRAM cluster whose superuser has a password — exactly the README's local validation recipe.
  const pwFile = join(dataDir, "pw");
  writeFileSync(pwFile, SUPER_PASSWORD, { mode: 0o600 });
  run(join(bin, "initdb"), [
    "-D",
    join(dataDir, "data"),
    "-U",
    "postgres",
    "--auth=scram-sha-256",
    `--pwfile=${pwFile}`,
    "--encoding=UTF8",
    "--no-locale",
  ]);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own mkdtemp() path
  appendFileSync(
    join(dataDir, "data", "postgresql.conf"),
    [`port = ${port}`, `listen_addresses = '127.0.0.1'`, `fsync = off`, ""].join("\n"),
  );
  run(join(bin, "pg_ctl"), [
    "-D",
    join(dataDir, "data"),
    "-l",
    join(dataDir, "server.log"),
    "-W",
    "start",
  ]);
  for (let i = 0; i < 60; i++) {
    const ready = spawnSync(join(bin, "pg_isready"), ["-h", "127.0.0.1", "-p", String(port), "-q"]);
    if (ready.status === 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  // 127.0.0.1 is loopback, so the target-cluster assertion is exempt — this test is about the
  // PASSWORD path, and mixing the two concerns would make a failure ambiguous.
  process.env.TEST_DATABASE_URL = `postgres://postgres:${SUPER_PASSWORD}@127.0.0.1:${port}/postgres?sslmode=disable`;
  pg = await startEphemeralPostgres();
}, 120_000);

afterAll(async () => {
  if (!hasLocalPostgresBinaries()) return;
  await provider?.end();
  await pg?.stop();
  if (priorUrl === undefined) delete process.env.TEST_DATABASE_URL;
  else process.env.TEST_DATABASE_URL = priorUrl;
  try {
    run(join(pgBinDirForTests(), "pg_ctl"), [
      "-D",
      join(dataDir, "data"),
      "-m",
      "immediate",
      "-W",
      "stop",
    ]);
  } catch {
    // best effort; the temp dir goes either way
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // a leaked temp dir is reaped by the OS; never fail teardown on cleanup
  }
});

// The handshake itself needs binaries to spin a SCRAM cluster with — CI's `test-db` lane has a
// postgres SERVICE CONTAINER (trust auth, no local install), so it genuinely cannot run this half.
// It runs on every developer machine and is where the 28P01 regression was caught. The assertions
// above cover the same defect everywhere; this is not a failing test being hidden.
describe.skipIf(!hasLocalPostgresBinaries())("password-auth cluster handed a superuser", () => {
  it("detects password mode and downgrades to the provisioned provider", () => {
    expect(pg?.auth).toBe("password");
    expect(pg?.providerRole).toBe("test_provider");
  });

  it("gives the provisioned provider a password it can actually log in with", async () => {
    // The regression. Without a minted password this URL is password-less and the connect fails
    // `28P01 password authentication failed for user "test_provider"`.
    provider = createClient(pg!.providerUrl);
    const [row] = await provider<{ ok: number }[]>`select 1 as ok`;
    expect(row!.ok).toBe(1);
  });

  it("is still a non-superuser here too — password mode must not buy back privileges", async () => {
    const [row] = await provider!<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    expect(row!.rolsuper).toBe(false);
    expect(row!.rolbypassrls).toBe(true);
  });
});
