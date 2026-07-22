import { runChecks } from "@webhook-co/shared/health";
import { describe, expect, it, vi } from "vitest";

import { GET, webReadinessChecks } from "./route";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({
    env: { HYPERDRIVE_TENANT: { connectionString: "postgres://app" } },
  })),
}));
vi.mock("@webhook-co/db/health", () => ({ pingDatabase: vi.fn(async () => {}) }));

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

// THE GAP THAT LET A 500 SHIP. The check builder was tested; the HANDLER -- which is where the
// runtime declaration and the context accessor live -- was not. Both were wrong in production:
// `runtime = "edge"` plus the SYNC getCloudflareContext() threw, so the endpoint returned 500
// instead of a readiness verdict, and no test could have noticed.
describe("the route handler itself", () => {
  it("returns a readiness verdict rather than throwing", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"status":"pass"}');
  });

  it("does not declare the edge runtime", async () => {
    const mod: Record<string, unknown> = await import("./route");
    // OpenNext runs Next in the Node runtime on workerd; declaring "edge" builds this as an Edge
    // Function where getCloudflareContext is not available the same way.
    expect(mod.runtime).toBeUndefined();
  });
});
