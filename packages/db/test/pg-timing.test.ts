import { afterEach, describe, expect, it, vi } from "vitest";

import { isRemoteTestDatabase, remoteTestTimeouts, waitForDatabase } from "./pg-timing";

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
    expect(onRetry.mock.calls[0][0]).toMatchObject({ attempt: 1, attempts: 5 });
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
