import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runAuthExpirySweep } from "./sweep-cron";

// The cross-org expiry sweep's I/O glue (ADR-0055) had no test file at all, at either level: neither this
// module nor the scheduled() gate that decides whether it runs. Its contract is that a failure — from a
// missing binding or from the database — is a clean, silent no-op: a scheduled handler has no caller to
// answer, so it must never surface as a rejection that marks the whole hourly invocation failed (and, since
// apps/auth never calls controller.noRetry(), could invite a re-invocation that re-sends the sibling drain's
// owner emails).
//
// The prune itself (pruneAllExpiredAuthTokens) is exercised against real Postgres in @webhook-co/db, where
// the role-targeted `USING (expires_at < now())` policy can actually be enforced. What is asserted here is
// what this module owns: env validation, the structured log lines, pool close in a finally, and that a
// credential never reaches a log sink on ANY path.

const { createClient, pruneAllExpiredAuthTokens } = vi.hoisted(() => ({
  createClient: vi.fn(),
  pruneAllExpiredAuthTokens: vi.fn(),
}));

vi.mock("@webhook-co/db", () => ({ createClient, pruneAllExpiredAuthTokens }));

const CONNECTION = "postgres://webhook_sweeper:SUPER_SECRET@db.invalid/neondb";
const validEnv = { HYPERDRIVE_SWEEPER: { connectionString: CONNECTION } };

function captureLogs(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    lines.push(line);
  });
  return lines;
}

const messages = (lines: readonly string[]): string[] =>
  lines.map((line) => (JSON.parse(line) as { message: string }).message);

/** A fake postgres.js client that records whether it was closed. */
function fakeSql(endBehaviour: "ok" | "throws" = "ok") {
  const state = { ended: false };
  const end = vi.fn(async () => {
    state.ended = true;
    if (endBehaviour === "throws") throw new Error("pool close exploded");
  });
  return { state, client: { end } };
}

beforeEach(() => {
  createClient.mockReset();
  pruneAllExpiredAuthTokens.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runAuthExpirySweep — unprovisioned deployments are a clean no-op", () => {
  it("returns null and logs, rather than throwing, when the Hyperdrive binding is absent", async () => {
    const lines = captureLogs();

    await expect(runAuthExpirySweep({})).resolves.toBeNull();

    expect(messages(lines)).toEqual(["auth.sweep.cron.error"]);
    // It must not have reached the database at all.
    expect(createClient).not.toHaveBeenCalled();
  });

  it("treats a malformed binding as unprovisioned", async () => {
    for (const binding of [{}, { connectionString: "" }, { connectionString: 42 }, null]) {
      const lines = captureLogs();

      await expect(runAuthExpirySweep({ HYPERDRIVE_SWEEPER: binding })).resolves.toBeNull();

      expect(messages(lines)).toEqual(["auth.sweep.cron.error"]);
      vi.restoreAllMocks();
    }
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("runAuthExpirySweep — the provisioned path", () => {
  it("prunes over the sweeper binding, logs the counts, and closes the pool", async () => {
    const { state, client } = fakeSql();
    createClient.mockReturnValue(client);
    pruneAllExpiredAuthTokens.mockResolvedValue({ refreshTokens: 3, sessionExchanges: 5 });
    const lines = captureLogs();

    await expect(runAuthExpirySweep(validEnv)).resolves.toEqual({
      refreshTokens: 3,
      sessionExchanges: 5,
    });

    // The sweeper's OWN binding, never another role's — it carries the least-privilege credential.
    expect(createClient).toHaveBeenCalledWith(CONNECTION, { max: 1 });
    expect(pruneAllExpiredAuthTokens).toHaveBeenCalledWith(client);
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry.message).toBe("auth.sweep.cron");
    expect(entry.refreshTokens).toBe(3);
    expect(entry.sessionExchanges).toBe(5);
    expect(state.ended).toBe(true);
  });

  it("swallows a database failure, returns null, and STILL closes the pool", async () => {
    const { state, client } = fakeSql();
    createClient.mockReturnValue(client);
    pruneAllExpiredAuthTokens.mockRejectedValue(new Error("deadlock detected"));
    const lines = captureLogs();

    await expect(runAuthExpirySweep(validEnv)).resolves.toBeNull();

    expect(messages(lines)).toEqual(["auth.sweep.cron.error"]);
    // A leaked Hyperdrive connection every hour is why the finally exists; delete it and this fails.
    expect(state.ended).toBe(true);
  });

  it("reports a pool-close failure without turning it into a rejection", async () => {
    const { client } = fakeSql("throws");
    createClient.mockReturnValue(client);
    pruneAllExpiredAuthTokens.mockResolvedValue({ refreshTokens: 0, sessionExchanges: 0 });
    const lines = captureLogs();

    await expect(runAuthExpirySweep(validEnv)).resolves.toEqual({
      refreshTokens: 0,
      sessionExchanges: 0,
    });

    expect(messages(lines)).toEqual(["auth.sweep.cron", "auth.sweep.cron.pool_close_failed"]);
  });

  it("never leaks the connection string on the RUNTIME failure path", async () => {
    // The path that actually matters: here `validated` exists and the credential-bearing connection string
    // is in scope, so an error log that interpolated it would leak. The validation-failure test above
    // cannot cover this — it returns before the binding is ever read. (no-secrets)
    const { client } = fakeSql();
    createClient.mockReturnValue(client);
    pruneAllExpiredAuthTokens.mockRejectedValue(new Error(`connection to ${CONNECTION} failed`));
    const lines = captureLogs();

    await expect(runAuthExpirySweep(validEnv)).resolves.toBeNull();

    expect(lines).not.toHaveLength(0);
    for (const line of lines) {
      expect(line).not.toContain("SUPER_SECRET");
    }
  });
});
