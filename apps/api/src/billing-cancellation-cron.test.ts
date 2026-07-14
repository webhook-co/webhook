import { afterEach, describe, expect, it, vi } from "vitest";

import { runBillingCancellationCron } from "./billing-cancellation-cron.js";

// The cron SHELL's fail-closed guards (the pure drain logic is covered in
// packages/db/test/billing-cancellation.test.ts against real Postgres). A scheduled handler has no caller to
// answer, so a misconfigured deployment must be a SILENT no-op — never a throw that wedges the shared hourly
// invocation, and never a Stripe client built against the wrong account (canceling live subscriptions is
// exactly the operation that must not run against the wrong mode/account).

afterEach(() => vi.restoreAllMocks());

describe("runBillingCancellationCron — dark until fully provisioned", () => {
  it("is a no-op when BILLING_MODE is off (no key/hyperdrive touched)", async () => {
    await expect(runBillingCancellationCron({ BILLING_MODE: "off" })).resolves.toBeUndefined();
  });

  it("is a no-op when BILLING_MODE is unset", async () => {
    await expect(runBillingCancellationCron({})).resolves.toBeUndefined();
  });

  it("is a no-op when the Stripe key is absent, even in live mode", async () => {
    // HYPERDRIVE_BILLING present but no key → dark. Must not attempt a Stripe cancel or open the connection.
    const hyperdrive = { connectionString: "postgres://should-not-be-used" } as never;
    await expect(
      runBillingCancellationCron({ BILLING_MODE: "live", HYPERDRIVE_BILLING: hyperdrive }),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when the billing Hyperdrive is unprovisioned", async () => {
    const secret = { get: async () => "sk_live_x" } as unknown as SecretsStoreSecret;
    await expect(
      runBillingCancellationCron({ BILLING_MODE: "live", STRIPE_SECRET_KEY: secret }),
    ).resolves.toBeUndefined();
  });

  it("logs a key/mode mismatch and does NOT drain (a test key under live mode)", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(line);
    });
    const secret = { get: async () => "sk_test_x" } as unknown as SecretsStoreSecret;
    const hyperdrive = { connectionString: "postgres://should-not-be-used" } as never;

    await runBillingCancellationCron({
      BILLING_MODE: "live",
      STRIPE_SECRET_KEY: secret,
      HYPERDRIVE_BILLING: hyperdrive,
    });

    expect(logs.some((l) => l.includes("key_mode_mismatch"))).toBe(true);
    expect(logs.some((l) => l.includes("billing.cancel.done"))).toBe(false);
  });
});
