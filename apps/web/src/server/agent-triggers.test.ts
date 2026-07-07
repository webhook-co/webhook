import { beforeEach, describe, expect, it, vi } from "vitest";

const { logActionError } = vi.hoisted(() => ({ logActionError: vi.fn() }));
vi.mock("./action-log", () => ({ logActionError }));
// The loader must never touch the pool when readers are injected; make the db helper throw if it's reached.
vi.mock("./db", () => ({
  withTenantDb: () => {
    throw new Error("withTenantDb should not be called when readers are injected");
  },
}));

import { loadTriggers, toTriggerItem, type TriggerReaders } from "./agent-triggers";

const ORG = "org-1";
const record = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  orgId: ORG,
  endpointId: "22222222-2222-4222-8222-222222222222",
  name: "fraud-agent",
  createdAt: new Date("2026-07-07T00:00:00.000Z"),
  revokedAt: null,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("toTriggerItem", () => {
  it("strips the internal orgId pointer, keeps everything else", () => {
    const item = toTriggerItem(record());
    expect(item).not.toHaveProperty("orgId");
    expect(item).toMatchObject({
      id: record().id,
      endpointId: record().endpointId,
      name: "fraud-agent",
    });
  });
});

describe("loadTriggers", () => {
  it("returns the org's triggers as orgId-stripped items", async () => {
    const readers: TriggerReaders = {
      list: vi.fn(async () => [record(), record({ id: "b", name: null })]),
    };
    const res = await loadTriggers(ORG, readers);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("expected ok");
    expect(res.items).toHaveLength(2);
    expect(res.items[0]).not.toHaveProperty("orgId");
    expect(readers.list).toHaveBeenCalledWith(ORG);
  });

  it("maps a db fault to {status:error} and scrubs it via logActionError", async () => {
    const readers: TriggerReaders = {
      list: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const res = await loadTriggers(ORG, readers);
    expect(res.status).toBe("error");
    expect(logActionError).toHaveBeenCalledWith("triggers.load", expect.any(Error));
  });
});
