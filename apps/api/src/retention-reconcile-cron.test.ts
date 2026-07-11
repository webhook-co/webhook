import { afterEach, describe, expect, it, vi } from "vitest";

import { runRetentionReconcileCron } from "./retention-reconcile-cron.js";

// The cron SHELL's fail-closed guards (the pure reconcile logic is covered in
// packages/db/test/retention-reconcile.test.ts against real Postgres). A scheduled handler has no caller to
// answer, so a misconfigured deployment must be a SILENT no-op — never a throw that wedges the shared hourly
// invocation, and never a client built against the wrong account.

afterEach(() => vi.restoreAllMocks());

describe("runRetentionReconcileCron — dark until fully provisioned", () => {
  it("is a no-op when BILLING_MODE is off (no key/hyperdrive touched)", async () => {
    await expect(runRetentionReconcileCron({ BILLING_MODE: "off" })).resolves.toBeUndefined();
  });

  it("is a no-op when BILLING_MODE is unset", async () => {
    await expect(runRetentionReconcileCron({})).resolves.toBeUndefined();
  });

  it("is a no-op when the Stripe key is absent, even in live mode", async () => {
    // HYPERDRIVE_BILLING present but no key → dark. Must not attempt a Stripe list or open the connection.
    const hyperdrive = { connectionString: "postgres://should-not-be-used" } as never;
    await expect(
      runRetentionReconcileCron({ BILLING_MODE: "live", HYPERDRIVE_BILLING: hyperdrive }),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when the billing Hyperdrive is unprovisioned", async () => {
    const secret = { get: async () => "sk_live_x" } as unknown as SecretsStoreSecret;
    await expect(
      runRetentionReconcileCron({ BILLING_MODE: "live", STRIPE_SECRET_KEY: secret }),
    ).resolves.toBeUndefined();
  });

  it("logs a key/mode mismatch and does NOT reconcile (a test key under live mode)", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(line);
    });
    const secret = { get: async () => "sk_test_x" } as unknown as SecretsStoreSecret;
    const hyperdrive = { connectionString: "postgres://should-not-be-used" } as never;

    await runRetentionReconcileCron({
      BILLING_MODE: "live",
      STRIPE_SECRET_KEY: secret,
      HYPERDRIVE_BILLING: hyperdrive,
    });

    expect(logs.some((l) => l.includes("key_mode_mismatch"))).toBe(true);
    expect(logs.some((l) => l.includes("retention_reconcile.done"))).toBe(false);
  });
});
