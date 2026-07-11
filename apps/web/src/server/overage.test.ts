import { afterEach, describe, expect, it, vi } from "vitest";

// overage.ts is thin orchestration: DB flip + durable ingest_paused reconcile (setOverageEnabled) → a
// best-effort engine cache eviction (only when the pause state transitioned) → status. Drive it with fakes
// and assert the gating, that eviction fires ONLY on a transition, and that a missing/failing/slow eviction
// degrades to ok (the durable flip already stands) rather than throwing.

const env = vi.hoisted(() => ({
  getAuditChainKey: vi.fn().mockResolvedValue("YWJj"),
  getFreeEventCap: vi.fn().mockReturnValue(null),
  getIngestCacheEvictor: vi.fn(),
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
  it("flips the DB then evicts the ingest cache when the pause state TRANSITIONED", async () => {
    const evictOrgIngestCache = vi.fn().mockResolvedValue(undefined);
    env.getIngestCacheEvictor.mockReturnValue({ evictOrgIngestCache });
    overagePolicy.setOverageEnabled.mockResolvedValue({
      status: "ok",
      policy: "pause",
      changed: true,
      transitioned: true,
    });

    expect(await applyOverageToggle("org-1", "user-1", false)).toEqual({
      status: "ok",
      enabled: false,
    });
    expect(overagePolicy.setOverageEnabled).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ orgId: "org-1", userId: "user-1", enabled: false }),
    );
    expect(evictOrgIngestCache).toHaveBeenCalledWith("org-1");
  });

  it("does NOT evict when the flip changed the policy but NOT the pause state (transitioned:false)", async () => {
    const evictOrgIngestCache = vi.fn();
    env.getIngestCacheEvictor.mockReturnValue({ evictOrgIngestCache });
    overagePolicy.setOverageEnabled.mockResolvedValue({
      status: "ok",
      policy: "allow",
      changed: true,
      transitioned: false,
    });

    expect(await applyOverageToggle("org-1", "user-1", true)).toEqual({
      status: "ok",
      enabled: true,
    });
    expect(evictOrgIngestCache).not.toHaveBeenCalled();
  });

  it("does NOT evict on a no-op (changed:false)", async () => {
    const evictOrgIngestCache = vi.fn();
    env.getIngestCacheEvictor.mockReturnValue({ evictOrgIngestCache });
    overagePolicy.setOverageEnabled.mockResolvedValue({
      status: "ok",
      policy: "allow",
      changed: false,
      transitioned: false,
    });

    expect(await applyOverageToggle("org-1", "user-1", true)).toEqual({
      status: "ok",
      enabled: true,
    });
    expect(evictOrgIngestCache).not.toHaveBeenCalled();
  });

  it("surfaces forbidden (not owner/admin) and never touches the engine", async () => {
    const evictOrgIngestCache = vi.fn();
    env.getIngestCacheEvictor.mockReturnValue({ evictOrgIngestCache });
    overagePolicy.setOverageEnabled.mockResolvedValue({ status: "forbidden" });

    expect(await applyOverageToggle("org-1", "user-1", true)).toEqual({ status: "forbidden" });
    expect(evictOrgIngestCache).not.toHaveBeenCalled();
  });

  it("surfaces no_subscription for a Free org", async () => {
    env.getIngestCacheEvictor.mockReturnValue({ evictOrgIngestCache: vi.fn() });
    overagePolicy.setOverageEnabled.mockResolvedValue({ status: "no_subscription" });
    expect(await applyOverageToggle("org-1", "user-1", true)).toEqual({
      status: "no_subscription",
    });
  });

  it("degrades to ok (logged) when the evictor binding is UNBOUND — the durable flip already stands", async () => {
    env.getIngestCacheEvictor.mockReturnValue(undefined); // dev/preview or a provisioning gap
    overagePolicy.setOverageEnabled.mockResolvedValue({
      status: "ok",
      policy: "pause",
      changed: true,
      transitioned: true,
    });

    expect(await applyOverageToggle("org-1", "user-1", false)).toEqual({
      status: "ok",
      enabled: false,
    });
    expect(log.logActionError).toHaveBeenCalledWith(
      "billing.overage_evict_unbound",
      expect.anything(),
    );
  });

  it("degrades to ok (logged) when the eviction RPC THROWS — enforcement is already durable", async () => {
    const evictOrgIngestCache = vi.fn().mockRejectedValue(new Error("engine down"));
    env.getIngestCacheEvictor.mockReturnValue({ evictOrgIngestCache });
    overagePolicy.setOverageEnabled.mockResolvedValue({
      status: "ok",
      policy: "allow",
      changed: true,
      transitioned: true,
    });

    expect(await applyOverageToggle("org-1", "user-1", true)).toEqual({
      status: "ok",
      enabled: true,
    });
    expect(log.logActionError).toHaveBeenCalledWith(
      "billing.overage_evict_failed",
      expect.anything(),
    );
  });

  it("maps an unexpected fault to 'error' (never throws)", async () => {
    env.getIngestCacheEvictor.mockReturnValue({ evictOrgIngestCache: vi.fn() });
    overagePolicy.setOverageEnabled.mockRejectedValue(new Error("db down"));
    expect(await applyOverageToggle("org-1", "user-1", true)).toEqual({ status: "error" });
  });
});
