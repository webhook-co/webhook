import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isRemoteTestDatabase,
  migrationRoundtripTimeoutMs,
  orphanTestDatabases,
  remoteTestTimeouts,
  roundTripHeavyTestTimeoutMs,
  setupHookTimeoutMs,
  waitForDatabase,
} from "./pg-timing";

describe("isRemoteTestDatabase", () => {
  // The function defaults its arg to process.env.TEST_DATABASE_URL, so the omitted-arg
  // cases MUST control the env explicitly — otherwise the ambient CI value (a real Neon
  // URL on the nightly) leaks in and flips the result. Restore env after each case.
  afterEach(() => vi.unstubAllEnvs());

  it("is false for an explicitly empty or blank url (no target)", () => {
    expect(isRemoteTestDatabase("")).toBe(false);
    expect(isRemoteTestDatabase("   ")).toBe(false);
  });

  it("falls back to TEST_DATABASE_URL when the url arg is omitted", () => {
    vi.stubEnv("TEST_DATABASE_URL", "");
    expect(isRemoteTestDatabase()).toBe(false);
    // A passwordless trust-auth CI service URL is still local, not remote.
    vi.stubEnv("TEST_DATABASE_URL", "postgres://postgres@127.0.0.1:5432/webhook_test");
    expect(isRemoteTestDatabase()).toBe(false);
    // A managed engine URL (password + TLS) is remote.
    vi.stubEnv("TEST_DATABASE_URL", "postgres://owner:secret@ep-x.neon.tech/db?sslmode=require");
    expect(isRemoteTestDatabase()).toBe(true);
  });

  it("is false for a trust-auth CI service container (no password, no ssl)", () => {
    expect(isRemoteTestDatabase("postgres://postgres@127.0.0.1:5432/webhook_test")).toBe(false);
    expect(
      isRemoteTestDatabase("postgres://postgres@localhost:5432/webhook_test?sslmode=disable"),
    ).toBe(false);
  });

  it("is true for a managed engine URL that carries a password (Neon)", () => {
    expect(
      isRemoteTestDatabase("postgres://owner:secret@ep-cool-123.neon.tech/db?sslmode=require"),
    ).toBe(true);
  });

  it("is true whenever sslmode=require is present even without a parseable password", () => {
    expect(isRemoteTestDatabase("postgres://user@host.example.com:5432/db?sslmode=require")).toBe(
      true,
    );
  });

  it("is false for an unparseable url rather than throwing", () => {
    expect(isRemoteTestDatabase("not a url")).toBe(false);
  });
});

describe("remoteTestTimeouts", () => {
  it("uses the tight local budgets for a local/ephemeral target", () => {
    const t = remoteTestTimeouts("postgres://postgres@127.0.0.1:5432/webhook_test");
    expect(t.testTimeout).toBe(30_000);
    expect(t.hookTimeout).toBe(60_000);
  });

  it("uses generous budgets for a remote Neon target so latency variance does not trip timeouts", () => {
    const t = remoteTestTimeouts("postgres://owner:secret@ep-x.neon.tech/db?sslmode=require");
    expect(t.testTimeout).toBeGreaterThanOrEqual(120_000);
    expect(t.hookTimeout).toBeGreaterThanOrEqual(t.testTimeout);
  });
});

describe("setupHookTimeoutMs", () => {
  // Same env-default caveat as isRemoteTestDatabase: the omitted-arg case must pin the env.
  afterEach(() => vi.unstubAllEnvs());

  it("keeps the local budget for a local/ephemeral target (no regression vs the prior 90s literal)", () => {
    expect(setupHookTimeoutMs("postgres://postgres@127.0.0.1:5432/webhook_test")).toBe(90_000);
  });

  it("widens the budget for a remote Neon target so a slow provisioning beforeAll does not tip over", () => {
    const remote = setupHookTimeoutMs("postgres://owner:secret@ep-x.neon.tech/db?sslmode=require");
    expect(remote).toBe(180_000);
    // The remote setup budget must exceed the local one (that is the whole point).
    expect(remote).toBeGreaterThan(setupHookTimeoutMs("postgres://postgres@127.0.0.1:5432/db"));
  });

  it("falls back to TEST_DATABASE_URL when the url arg is omitted", () => {
    vi.stubEnv("TEST_DATABASE_URL", "");
    expect(setupHookTimeoutMs()).toBe(90_000);
    vi.stubEnv("TEST_DATABASE_URL", "postgres://owner:secret@ep-x.neon.tech/db?sslmode=require");
    expect(setupHookTimeoutMs()).toBe(180_000);
  });
});

describe("roundTripHeavyTestTimeoutMs", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps the tight per-test local budget for a local/ephemeral target", () => {
    // Same value as the config's local testTimeout — 630 round-trips over a unix socket is seconds.
    expect(roundTripHeavyTestTimeoutMs("postgres://postgres@127.0.0.1:5432/webhook_test")).toBe(
      remoteTestTimeouts("postgres://postgres@127.0.0.1:5432/webhook_test").testTimeout,
    );
  });

  it("widens the budget well past the config ceiling for a remote Neon target", () => {
    const remote = roundTripHeavyTestTimeoutMs(
      "postgres://owner:secret@ep-x.neon.tech/db?sslmode=require",
    );
    // Must clear the 120s config testTimeout the round-trip-heavy test would otherwise inherit — a
    // ~4.4x slow-night suite slowdown put the 47s benchmark at ~207s, over that ceiling.
    expect(remote).toBeGreaterThan(
      remoteTestTimeouts("postgres://owner:secret@ep-x.neon.tech/db?sslmode=require").testTimeout,
    );
    expect(remote).toBeGreaterThanOrEqual(300_000);
    // And it must exceed the local budget (the whole point).
    expect(remote).toBeGreaterThan(
      roundTripHeavyTestTimeoutMs("postgres://postgres@127.0.0.1:5432/db"),
    );
  });

  it("falls back to TEST_DATABASE_URL when the url arg is omitted", () => {
    vi.stubEnv("TEST_DATABASE_URL", "");
    expect(roundTripHeavyTestTimeoutMs()).toBe(30_000);
    vi.stubEnv("TEST_DATABASE_URL", "postgres://owner:secret@ep-x.neon.tech/db?sslmode=require");
    expect(roundTripHeavyTestTimeoutMs()).toBe(300_000);
  });
});

describe("migrationRoundtripTimeoutMs", () => {
  it("scales with the migration count (auto-grows instead of drifting toward a fixed ceiling)", () => {
    // 6s/migration + 30s base — sized to dbmate's O(migrations) connection setups on Neon.
    expect(migrationRoundtripTimeoutMs(0)).toBe(30_000);
    expect(migrationRoundtripTimeoutMs(91)).toBe(91 * 6_000 + 30_000);
    // Strictly monotonic in the count — a bigger stack always gets a bigger budget.
    expect(migrationRoundtripTimeoutMs(100)).toBeGreaterThan(migrationRoundtripTimeoutMs(50));
  });

  it("clears the default remote per-test ceiling for a realistic stack (the 07-20 near-miss)", () => {
    // migration-0055-roundtrip sat at ~109s of the 120s default; a real stack (>=15 migrations) must
    // budget well past 120s so it cannot false-RED on a slow Neon night or as migrations accumulate.
    expect(migrationRoundtripTimeoutMs(20)).toBeGreaterThan(120_000);
  });
});

describe("orphanTestDatabases", () => {
  it("selects only the per-run test databases, excluding the maintenance/connection db", () => {
    const all = ["neondb", "postgres", "webhook_test_abc123", "webhook_test_def456"];
    expect(orphanTestDatabases(all, "neondb")).toEqual([
      "webhook_test_abc123",
      "webhook_test_def456",
    ]);
  });

  it("never returns the current connection database even if it matches the prefix", () => {
    // Defensive: the sweep must not try to drop the database it is connected through.
    const all = ["webhook_test_current", "webhook_test_stale"];
    expect(orphanTestDatabases(all, "webhook_test_current")).toEqual(["webhook_test_stale"]);
  });

  it("does not match the harness's default base name or unrelated databases", () => {
    // `webhook_test` (no suffix) is the local default DB name; only the suffixed per-run
    // databases are swept. Real app databases must never match.
    const all = ["webhook_test", "webhook_prod", "webhook", "template1"];
    expect(orphanTestDatabases(all, "postgres")).toEqual([]);
  });

  it("returns an empty list when there is nothing to sweep", () => {
    expect(orphanTestDatabases([], "neondb")).toEqual([]);
  });
});

describe("waitForDatabase", () => {
  it("returns immediately when the first probe succeeds", async () => {
    const probe = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await waitForDatabase({ probe, sleep, attempts: 5, delayMs: 1 });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a cold/suspended compute and resolves once it wakes", async () => {
    const probe = vi
      .fn()
      .mockRejectedValueOnce(new Error("CONNECT_TIMEOUT"))
      .mockRejectedValueOnce(new Error("CONNECT_TIMEOUT"))
      .mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();
    await waitForDatabase({ probe, sleep, onRetry, attempts: 5, delayMs: 3 });
    expect(probe).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]![0]).toMatchObject({ attempt: 1, attempts: 5 });
  });

  it("throws after exhausting all attempts, surfacing the last error, and does not sleep after the final attempt", async () => {
    const probe = vi.fn().mockRejectedValue(new Error("still asleep"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(waitForDatabase({ probe, sleep, attempts: 3, delayMs: 5 })).rejects.toThrow(
      /still asleep/,
    );
    expect(probe).toHaveBeenCalledTimes(3);
    // sleeps only BETWEEN attempts (2 gaps for 3 attempts), never after the last.
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
