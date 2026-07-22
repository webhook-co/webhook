import { runChecks } from "@webhook-co/shared/health";
import { describe, expect, it } from "vitest";

import { mcpReadinessChecks } from "../src/index";

const env = { HYPERDRIVE_AUTHN: { connectionString: "postgres://authn" } } as never;

describe("mcp readiness", () => {
  it("probes the webhook_authn binding every bearer is resolved through", async () => {
    const seen: string[] = [];
    await runChecks(mcpReadinessChecks(env, async (d) => void seen.push(d)) as never, {
      timeoutMs: 500,
    });
    expect(seen).toEqual(["postgres://authn"]);
  });

  it("reports fail rather than throwing when authn is unreachable", async () => {
    const out = await runChecks(
      mcpReadinessChecks(env, async () => {
        throw new Error("ECONNREFUSED");
      }) as never,
      { timeoutMs: 500 },
    );
    expect(out[0]).toMatchObject({ name: "authn", status: "fail" });
  });

  it("passes when authn answers", async () => {
    const out = await runChecks(mcpReadinessChecks(env, async () => {}) as never, {
      timeoutMs: 500,
    });
    expect(out[0]?.status).toBe("pass");
  });
});
