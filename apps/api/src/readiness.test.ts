import { runChecks } from "@webhook-co/shared/health";
import { describe, expect, it } from "vitest";

import { apiReadinessChecks } from "./index";

const env = {
  HYPERDRIVE_TENANT: { connectionString: "postgres://app" },
  HYPERDRIVE_AUTHN: { connectionString: "postgres://authn" },
} as never;

const statuses = async (checks: unknown) =>
  Object.fromEntries(
    (await runChecks(checks as never, { timeoutMs: 500 })).map((o) => [o.name, o.status]),
  );

describe("api readiness", () => {
  it("declares both roles on the authenticated request path", () => {
    expect(Object.keys(apiReadinessChecks(env, async () => {})).sort()).toEqual([
      "authn",
      "database",
    ]);
  });

  // A rotated password breaks ONE role while the cluster stays up. Probing a single binding — or
  // the wrong one — reports healthy straight through that.
  it("probes webhook_app and webhook_authn by their own connection strings", async () => {
    const seen: string[] = [];
    await runChecks(apiReadinessChecks(env, async (dsn) => void seen.push(dsn)) as never, {
      timeoutMs: 500,
    });
    expect(seen.sort()).toEqual(["postgres://app", "postgres://authn"]);
  });

  it("fails only the role that is broken", async () => {
    const checks = apiReadinessChecks(env, async (dsn) => {
      if (dsn === "postgres://authn") throw new Error("password authentication failed");
    });
    expect(await statuses(checks)).toEqual({ database: "pass", authn: "fail" });
  });

  it("passes when both roles answer", async () => {
    expect(await statuses(apiReadinessChecks(env, async () => {}))).toEqual({
      database: "pass",
      authn: "pass",
    });
  });
});
