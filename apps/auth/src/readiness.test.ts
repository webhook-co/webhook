import { runChecks } from "@webhook-co/shared/health";
import { describe, expect, it } from "vitest";

import { authReadinessChecks, hyperdriveDsn } from "./readiness";

const env = {
  HYPERDRIVE_AUTH: { connectionString: "postgres://auth" },
  HYPERDRIVE_TENANT: { connectionString: "postgres://app" },
};

const statuses = async (checks: unknown) =>
  Object.fromEntries(
    (await runChecks(checks as never, { timeoutMs: 500 })).map((o) => [o.name, o.status]),
  );

describe("auth readiness", () => {
  it("probes webhook_auth and webhook_app by their own connection strings", async () => {
    const seen: string[] = [];
    await runChecks(authReadinessChecks(env, async (d) => void seen.push(d)) as never, {
      timeoutMs: 500,
    });
    expect(seen.sort()).toEqual(["postgres://app", "postgres://auth"]);
  });

  it("fails only the role that is broken", async () => {
    const checks = authReadinessChecks(env, async (dsn) => {
      if (dsn === "postgres://auth") throw new Error("role does not exist");
    });
    expect(await statuses(checks)).toEqual({ database: "fail", tenant: "pass" });
  });

  // A misconfigured deploy must go RED. Returning a placeholder DSN instead of throwing would let
  // an unbound Worker report healthy.
  it("fails closed when a binding is missing entirely", async () => {
    const checks = authReadinessChecks(
      { HYPERDRIVE_TENANT: env.HYPERDRIVE_TENANT },
      async () => {},
    );
    expect(await statuses(checks)).toEqual({ database: "fail", tenant: "pass" });
  });

  it("hyperdriveDsn throws on an absent or empty binding", () => {
    expect(() => hyperdriveDsn({}, "HYPERDRIVE_AUTH")).toThrow();
    expect(() => hyperdriveDsn({ HYPERDRIVE_AUTH: {} }, "HYPERDRIVE_AUTH")).toThrow();
    expect(hyperdriveDsn(env, "HYPERDRIVE_AUTH")).toBe("postgres://auth");
  });
});
