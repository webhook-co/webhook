import { runChecks } from "@webhook-co/shared/health";
import { describe, expect, it } from "vitest";

import { webReadinessChecks } from "./route";

const statuses = async (checks: unknown) =>
  Object.fromEntries(
    (await runChecks(checks as never, { timeoutMs: 500 })).map((o) => [o.name, o.status]),
  );

describe("dashboard readiness", () => {
  it("probes the tenant binding the dashboard reads through", async () => {
    const seen: string[] = [];
    await runChecks(
      webReadinessChecks(
        { HYPERDRIVE_TENANT: { connectionString: "postgres://app" } },
        async (d) => void seen.push(d),
      ) as never,
      { timeoutMs: 500 },
    );
    expect(seen).toEqual(["postgres://app"]);
  });

  it("fails when the tenant database is unreachable", async () => {
    const checks = webReadinessChecks(
      { HYPERDRIVE_TENANT: { connectionString: "postgres://app" } },
      async () => {
        throw new Error("ECONNREFUSED");
      },
    );
    expect(await statuses(checks)).toEqual({ database: "fail" });
  });

  // A misconfigured deploy must go RED rather than quietly report healthy.
  it("fails closed when the binding is absent or empty", async () => {
    expect(await statuses(webReadinessChecks({}, async () => {}))).toEqual({ database: "fail" });
    expect(await statuses(webReadinessChecks({ HYPERDRIVE_TENANT: {} }, async () => {}))).toEqual({
      database: "fail",
    });
  });
});
