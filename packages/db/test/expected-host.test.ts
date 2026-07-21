// The target-cluster assertion (#727). These are pure unit tests — no database is touched.
//
// The hazard being pinned: the harness's password path rotates CLUSTER-GLOBAL role passwords,
// `DROP DATABASE … WITH (FORCE)`s every `webhook_test_*` it can see, and (in migrations.test.ts)
// rolls migrations down far enough to DROP those roles. Every environment uses the SAME role
// names and every role create is `if not exists`-guarded, so a mis-pasted TEST_DATABASE_URL does
// not fail early — it proceeds and lands its damage on whatever cluster it actually named.

import { afterEach, describe, expect, it } from "vitest";

import {
  assertExpectedTestDatabaseHost,
  EXPECTED_HOST_ENV,
  UnexpectedTestClusterError,
} from "./expected-host";
import { startEphemeralPostgres } from "./pg";

const REMOTE =
  "postgres://neondb_owner:sekret@ep-real-host-123.us-east-2.aws.neon.tech/neondb?sslmode=require";
const TRUST_CI = "postgres://postgres@localhost:5432/postgres";

describe("assertExpectedTestDatabaseHost", () => {
  it("is a no-op for the local ephemeral cluster (no TEST_DATABASE_URL)", () => {
    expect(() => assertExpectedTestDatabaseHost(undefined, undefined)).not.toThrow();
    expect(() => assertExpectedTestDatabaseHost("", undefined)).not.toThrow();
    expect(() => assertExpectedTestDatabaseHost("   ", undefined)).not.toThrow();
  });

  it("is a no-op for a trust-auth CI service (no password, no TLS) — the fast lanes cost nothing", () => {
    expect(() => assertExpectedTestDatabaseHost(TRUST_CI, undefined)).not.toThrow();
  });

  it("REFUSES when the expectation is unset, rather than defaulting to 'allow'", () => {
    expect(() => assertExpectedTestDatabaseHost(REMOTE, undefined)).toThrow(
      UnexpectedTestClusterError,
    );
    expect(() => assertExpectedTestDatabaseHost(REMOTE, "")).toThrow(UnexpectedTestClusterError);
    expect(() => assertExpectedTestDatabaseHost(REMOTE, "   ")).toThrow(UnexpectedTestClusterError);
  });

  it("throws when the expectation names a DIFFERENT cluster", () => {
    expect(() =>
      assertExpectedTestDatabaseHost(REMOTE, "ep-some-other-host.us-east-2.aws.neon.tech"),
    ).toThrow(UnexpectedTestClusterError);
  });

  it("throws on a host that merely LOOKS like the expected one (no prefix/suffix matching)", () => {
    // A substring/startsWith check would let a pooler endpoint, or an attacker-ish
    // `ep-real-host-123.us-east-2.aws.neon.tech.evil.test`, through.
    for (const expected of [
      "ep-real-host-123",
      "ep-real-host-123.us-east-2.aws.neon.tech.evil.test",
      "real-host-123.us-east-2.aws.neon.tech",
      "ep-real-host-123-pooler.us-east-2.aws.neon.tech",
    ]) {
      expect(() => assertExpectedTestDatabaseHost(REMOTE, expected)).toThrow(
        UnexpectedTestClusterError,
      );
    }
  });

  it("passes when the expectation matches the URL's host exactly (surrounding whitespace tolerated)", () => {
    expect(() =>
      assertExpectedTestDatabaseHost(REMOTE, "ep-real-host-123.us-east-2.aws.neon.tech"),
    ).not.toThrow();
    expect(() =>
      assertExpectedTestDatabaseHost(REMOTE, "  ep-real-host-123.us-east-2.aws.neon.tech\n"),
    ).not.toThrow();
  });

  it("guards a TLS URL even when it carries no password (fail closed on the broader predicate)", () => {
    const tlsNoPassword =
      "postgres://someone@ep-real-host-123.us-east-2.aws.neon.tech/db?sslmode=require";
    expect(() => assertExpectedTestDatabaseHost(tlsNoPassword, undefined)).toThrow(
      UnexpectedTestClusterError,
    );
  });

  it("fails closed on an unparseable URL rather than assuming it is local", () => {
    expect(() => assertExpectedTestDatabaseHost("not a url", undefined)).toThrow(
      UnexpectedTestClusterError,
    );
  });

  it("NEVER echoes the connection string or its password — only the parsed host", () => {
    let message = "";
    try {
      assertExpectedTestDatabaseHost(REMOTE, "ep-expected.aws.neon.tech");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("sekret");
    expect(message).not.toContain(REMOTE);
    expect(message).not.toContain("postgres://");
    expect(message).toContain("ep-real-host-123.us-east-2.aws.neon.tech");
    expect(message).toContain(EXPECTED_HOST_ENV);
  });

  it("reads the process environment when its arguments are omitted", () => {
    const priorUrl = process.env.TEST_DATABASE_URL;
    const priorExpected = process.env[EXPECTED_HOST_ENV];
    try {
      process.env.TEST_DATABASE_URL = REMOTE;
      delete process.env[EXPECTED_HOST_ENV];
      expect(() => assertExpectedTestDatabaseHost()).toThrow(UnexpectedTestClusterError);
      process.env[EXPECTED_HOST_ENV] = "ep-real-host-123.us-east-2.aws.neon.tech";
      expect(() => assertExpectedTestDatabaseHost()).not.toThrow();
    } finally {
      restoreEnv("TEST_DATABASE_URL", priorUrl);
      restoreEnv(EXPECTED_HOST_ENV, priorExpected);
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("the guard runs BEFORE the harness touches the cluster", () => {
  const priorUrl = process.env.TEST_DATABASE_URL;
  const priorExpected = process.env[EXPECTED_HOST_ENV];

  afterEach(() => {
    restoreEnv("TEST_DATABASE_URL", priorUrl);
    restoreEnv(EXPECTED_HOST_ENV, priorExpected);
  });

  // ORDERING, not just "it throws": the host below cannot resolve, so ANY attempt to connect
  // (the `create database` that opens the password path) would fail with a DNS/connection error
  // instead. Getting UnexpectedTestClusterError back is proof we short-circuited before the first
  // statement — which is the whole point, since that statement is already destructive.
  it("startEphemeralPostgres refuses an unexpected cluster without opening a connection", async () => {
    process.env.TEST_DATABASE_URL =
      "postgres://someone:sekret@this-host-does-not-resolve.invalid:5432/db?sslmode=require";
    delete process.env[EXPECTED_HOST_ENV];

    await expect(startEphemeralPostgres()).rejects.toThrow(UnexpectedTestClusterError);
  });

  it("startEphemeralPostgres refuses when the expectation names a different cluster", async () => {
    process.env.TEST_DATABASE_URL =
      "postgres://someone:sekret@this-host-does-not-resolve.invalid:5432/db?sslmode=require";
    process.env[EXPECTED_HOST_ENV] = "some-other-host.invalid";

    await expect(startEphemeralPostgres()).rejects.toThrow(UnexpectedTestClusterError);
  });
});
