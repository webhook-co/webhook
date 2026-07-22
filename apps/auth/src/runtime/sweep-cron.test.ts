import { afterEach, describe, expect, it, vi } from "vitest";

import { runAuthExpirySweep } from "./sweep-cron";

// The cross-org expiry sweep's I/O glue (ADR-0055) had no test file at all, at either level: neither this
// module nor the scheduled() gate that decides whether it runs. Its contract is that an UNPROVISIONED
// deployment is a clean, silent no-op — a scheduled handler has no caller to answer, so a missing binding
// must never surface as a rejection that marks the whole hourly invocation failed (and, since apps/auth
// never calls controller.noRetry(), could invite a re-invocation that re-sends the sibling drain's emails).
//
// The prune itself (pruneAllExpiredAuthTokens) is exercised against real Postgres in @webhook-co/db, where
// the role-targeted `USING (expires_at < now())` policy can actually be enforced. What is asserted here is
// the guard the glue owns: a malformed env is logged and swallowed, never thrown.

function captureLogs(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    lines.push(line);
  });
  return lines;
}

const messages = (lines: readonly string[]): string[] =>
  lines.map((line) => (JSON.parse(line) as { message: string }).message);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runAuthExpirySweep — unprovisioned deployments are a clean no-op", () => {
  it("returns null and logs, rather than throwing, when the Hyperdrive binding is absent", async () => {
    const lines = captureLogs();

    await expect(runAuthExpirySweep({})).resolves.toBeNull();

    expect(messages(lines)).toEqual(["auth.sweep.cron.error"]);
  });

  it("treats a malformed binding as unprovisioned", async () => {
    for (const binding of [
      {}, // no connectionString
      { connectionString: "" }, // empty
      { connectionString: 42 }, // wrong type
      null,
    ]) {
      const lines = captureLogs();

      await expect(runAuthExpirySweep({ HYPERDRIVE_SWEEPER: binding })).resolves.toBeNull();

      expect(messages(lines)).toEqual(["auth.sweep.cron.error"]);
      vi.restoreAllMocks();
    }
  });

  it("never leaks a credential from the binding into the log line", async () => {
    // A Hyperdrive connection string embeds a role credential, so it must never reach a log sink
    // (no-secrets). Driven through the VALIDATION failure path deliberately: a binding that looked valid
    // would have the cron open a client and dial out, making this test depend on a DNS/connect failure.
    const secret = "postgres://webhook_sweeper:SUPER_SECRET@db.invalid/neondb";
    const lines = captureLogs();

    await expect(
      runAuthExpirySweep({ HYPERDRIVE_SWEEPER: { connectionString: "", credential: secret } }),
    ).resolves.toBeNull();

    expect(messages(lines)).toEqual(["auth.sweep.cron.error"]);
    for (const line of lines) {
      expect(line).not.toContain("SUPER_SECRET");
    }
  });
});
