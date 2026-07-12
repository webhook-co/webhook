import { beforeEach, describe, expect, it, vi } from "vitest";

// The point of this suite: loadDashboard is the fault-isolation composer. A blip in ONE signal must degrade
// that tile to its safe default, never throw and 500 the page a user hits on every login. We mock the leaf
// reads and the tenant-pool wrappers (pass-throughs) so we can drive each leg to succeed or throw.

const readDeliveryStatsSeries = vi.fn();
const readBillingSummary = vi.fn();
const loadUsage = vi.fn();
const loadDestinations = vi.fn();

vi.mock("@webhook-co/db", () => ({
  readDeliveryStatsSeries: (...a: unknown[]) => readDeliveryStatsSeries(...a),
}));
vi.mock("@webhook-co/db/reads", () => ({
  readBillingSummary: (...a: unknown[]) => readBillingSummary(...a),
}));
// Tenant wrappers as pass-throughs: withTenantDb(fn) → fn(app); withTenant(app, org, fn) → fn(tx).
vi.mock("./db", () => ({ withTenantDb: (fn: (app: unknown) => unknown) => fn({}) }));
vi.mock("@webhook-co/db/client", () => ({
  withTenant: (_app: unknown, _org: string, fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock("./usage", () => ({ loadUsage: (...a: unknown[]) => loadUsage(...a) }));
vi.mock("./replay-destinations", () => ({
  loadDestinations: (...a: unknown[]) => loadDestinations(...a),
}));
vi.mock("./action-log", () => ({ logActionError: vi.fn() }));

import { loadDashboard } from "./dashboard";

beforeEach(() => {
  readDeliveryStatsSeries.mockReset();
  readBillingSummary.mockReset();
  loadUsage.mockReset();
  loadDestinations.mockReset();
});

describe("loadDashboard", () => {
  it("maps every signal through when all reads succeed", async () => {
    readDeliveryStatsSeries.mockResolvedValue([
      {
        windowStart: "2026-07-07T00:00:00.000Z",
        delivered: 3,
        dead: 0,
        blocked: 0,
        p95DurationMs: 10,
      },
    ]);
    readBillingSummary.mockResolvedValue({ status: "past_due" });
    loadUsage.mockResolvedValue({ status: "ok", usage: { paused: true } });
    loadDestinations.mockResolvedValue({
      status: "ok",
      items: [{ disabledAt: new Date() }, { disabledAt: null }], // one disabled, one healthy
    });

    const data = await loadDashboard("org_1", { days: 14, endMs: Date.now() });
    expect(data).toMatchObject({
      seriesOk: true,
      paused: true,
      disabledDestinationCount: 1,
      pastDue: true,
    });
    expect(data.series).toHaveLength(1);
  });

  it("degrades the series tile (seriesOk=false) when the series read throws — never rejects", async () => {
    readDeliveryStatsSeries.mockRejectedValue(new Error("db down"));
    readBillingSummary.mockResolvedValue({ status: "active" });
    loadUsage.mockResolvedValue({ status: "ok", usage: { paused: true } });
    loadDestinations.mockResolvedValue({ status: "ok", items: [] });

    const data = await loadDashboard("org_1", { days: 14, endMs: Date.now() });
    expect(data.seriesOk).toBe(false);
    expect(data.series).toEqual([]);
    // The OTHER signals still come through — a series blip doesn't blank the page.
    expect(data.paused).toBe(true);
  });

  it("falls back to safe defaults when the non-series reads fault, without throwing", async () => {
    readDeliveryStatsSeries.mockResolvedValue([]);
    readBillingSummary.mockRejectedValue(new Error("stripe status read failed"));
    loadUsage.mockResolvedValue({ status: "error" }); // usage read faulted
    loadDestinations.mockResolvedValue({ status: "error" }); // destinations read faulted

    const data = await loadDashboard("org_1", { days: 14, endMs: Date.now() });
    expect(data).toMatchObject({
      seriesOk: true,
      paused: false, // usage error → not paused
      disabledDestinationCount: 0, // destinations error → 0
      pastDue: false, // billing read threw → not past due
    });
  });
});
