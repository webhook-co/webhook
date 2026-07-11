import { afterEach, describe, expect, it, vi } from "vitest";

// overage.ts is thin orchestration: DB flip (setOverageEnabled) → immediate engine re-eval (best-effort) →
// status. Drive it with fakes and assert the gating + that the RPC fires only on a real change, and that a
// missing/failing RPC degrades to ok (the cron backstops) rather than throwing.

const env = vi.hoisted(() => ({
  getAuditChainKey: vi.fn().mockResolvedValue("YWJj"),
  getCapReEvaluator: vi.fn(),
}));
vi.mock("./env", () => env);

const db = vi.hoisted(() => ({ withTenantDb: vi.fn((fn: (app: unknown) => unknown) => fn({})) }));
vi.mock("./db", () => db);

const log = vi.hoisted(() => ({ logActionError: vi.fn() }));
vi.mock("./action-log", () => log);

const overagePolicy = vi.hoisted(() => ({ setOverageEnabled: vi.fn() }));
vi.mock("@webhook-co/db/overage-policy", () => overagePolicy);

// Audit-key resolution is not under test — stub the crypto so no real key material is needed.
vi.mock("@webhook-co/shared/audit", () => ({ importAuditKey: vi.fn().mockResolvedValue({}) }));
vi.mock("@webhook-co/shared/bytes", () => ({ b64ToBytes: vi.fn(() => new Uint8Array()) }));

import { applyOverageToggle } from "./overage";

afterEach(() => vi.clearAllMocks());

describe("applyOverageToggle", () => {
  it("on a real change, flips the DB then re-evaluates enforcement via the engine RPC", async () => {
    const reevaluateOrgCap = vi.fn().mockResolvedValue({ paused: false, transitioned: true });
    env.getCapReEvaluator.mockReturnValue({ reevaluateOrgCap });
    overagePolicy.setOverageEnabled.mockResolvedValue({
      status: "ok",
      policy: "allow",
      changed: true,
    });

    expect(await applyOverageToggle("org-1", "user-1", true)).toEqual({
      status: "ok",
      enabled: true,
    });
    expect(overagePolicy.setOverageEnabled).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        orgId: "org-1",
        userId: "user-1",
        enabled: true,
      },
    );
    expect(reevaluateOrgCap).toHaveBeenCalledWith("org-1");
  });

  it("does NOT re-evaluate when the policy was already at the target (changed:false)", async () => {
    const reevaluateOrgCap = vi.fn();
    env.getCapReEvaluator.mockReturnValue({ reevaluateOrgCap });
    overagePolicy.setOverageEnabled.mockResolvedValue({
      status: "ok",
      policy: "allow",
      changed: false,
    });

    expect(await applyOverageToggle("org-1", "user-1", true)).toEqual({
      status: "ok",
      enabled: true,
    });
    expect(reevaluateOrgCap).not.toHaveBeenCalled();
  });

  it("surfaces forbidden (not owner/admin) and never touches the engine", async () => {
    const reevaluateOrgCap = vi.fn();
    env.getCapReEvaluator.mockReturnValue({ reevaluateOrgCap });
    overagePolicy.setOverageEnabled.mockResolvedValue({ status: "forbidden" });

    expect(await applyOverageToggle("org-1", "user-1", true)).toEqual({ status: "forbidden" });
    expect(reevaluateOrgCap).not.toHaveBeenCalled();
  });

  it("surfaces no_subscription for a Free org", async () => {
    env.getCapReEvaluator.mockReturnValue({ reevaluateOrgCap: vi.fn() });
    overagePolicy.setOverageEnabled.mockResolvedValue({ status: "no_subscription" });
    expect(await applyOverageToggle("org-1", "user-1", true)).toEqual({
      status: "no_subscription",
    });
  });

  it("degrades to ok (logged) when the engine binding is UNBOUND — the cron backstops", async () => {
    env.getCapReEvaluator.mockReturnValue(undefined); // dev/preview or a provisioning gap
    overagePolicy.setOverageEnabled.mockResolvedValue({
      status: "ok",
      policy: "allow",
      changed: true,
    });

    expect(await applyOverageToggle("org-1", "user-1", true)).toEqual({
      status: "ok",
      enabled: true,
    });
    expect(log.logActionError).toHaveBeenCalledWith(
      "billing.overage_reeval_unbound",
      expect.anything(),
    );
  });

  it("degrades to ok (logged) when the engine RPC THROWS — the flip still stands, cron reconciles", async () => {
    const reevaluateOrgCap = vi.fn().mockRejectedValue(new Error("engine down"));
    env.getCapReEvaluator.mockReturnValue({ reevaluateOrgCap });
    overagePolicy.setOverageEnabled.mockResolvedValue({
      status: "ok",
      policy: "pause",
      changed: true,
    });

    expect(await applyOverageToggle("org-1", "user-1", false)).toEqual({
      status: "ok",
      enabled: false,
    });
    expect(log.logActionError).toHaveBeenCalledWith(
      "billing.overage_reeval_failed",
      expect.anything(),
    );
  });

  it("maps an unexpected fault to 'error' (never throws)", async () => {
    env.getCapReEvaluator.mockReturnValue({ reevaluateOrgCap: vi.fn() });
    overagePolicy.setOverageEnabled.mockRejectedValue(new Error("db down"));
    expect(await applyOverageToggle("org-1", "user-1", true)).toEqual({ status: "error" });
  });
});
