import { describe, expect, it, vi } from "vitest";

import {
  collectAllEndpoints,
  loadEndpoint,
  loadEndpoints,
  type EndpointItem,
  type EndpointReaders,
} from "./endpoints";

const ID = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060";
const ep: EndpointItem = {
  id: ID,
  name: "Stripe prod",
  paused: false,
  createdAt: new Date("2026-06-25T00:00:00Z"),
};

function readers(over: Partial<EndpointReaders> = {}): EndpointReaders {
  return {
    listEndpoints: vi.fn(async () => [ep]),
    getEndpoint: vi.fn(async () => ep),
    ...over,
  };
}

describe("loadEndpoints", () => {
  it("returns the org's endpoints on success", async () => {
    const result = await loadEndpoints("o", undefined, readers());
    expect(result).toEqual({ status: "ok", endpoints: [ep] });
  });

  it("threads the name filter into the list reader", async () => {
    const r = readers();
    await loadEndpoints("o", "stripe", r);
    expect(r.listEndpoints).toHaveBeenCalledWith("o", "stripe");
  });

  it("surfaces a db fault as the error state (no throw)", async () => {
    const result = await loadEndpoints(
      "o",
      undefined,
      readers({
        listEndpoints: vi.fn(async () => {
          throw new Error("hyperdrive down");
        }),
      }),
    );
    expect(result).toEqual({ status: "error" });
  });
});

describe("loadEndpoint", () => {
  it("returns the endpoint on success", async () => {
    const result = await loadEndpoint("o", ID, readers());
    expect(result).toEqual({ status: "ok", endpoint: ep });
  });

  it("returns not_found for an unknown / soft-deleted / cross-org id", async () => {
    const result = await loadEndpoint("o", ID, readers({ getEndpoint: vi.fn(async () => null) }));
    expect(result).toEqual({ status: "not_found" });
  });

  it("returns not_found for a non-uuid id WITHOUT touching the db (→ 404, not a retryable error)", async () => {
    const r = readers();
    const result = await loadEndpoint("o", "not-a-uuid", r);
    expect(result).toEqual({ status: "not_found" });
    expect(r.getEndpoint).not.toHaveBeenCalled();
  });

  it("surfaces a db fault as the error state (no throw)", async () => {
    const result = await loadEndpoint(
      "o",
      ID,
      readers({
        getEndpoint: vi.fn(async () => {
          throw new Error("hyperdrive down");
        }),
      }),
    );
    expect(result).toEqual({ status: "error" });
  });
});

describe("collectAllEndpoints", () => {
  const mk = (id: string, name: string): EndpointItem => ({
    id,
    name,
    paused: false,
    createdAt: new Date("2026-06-25T00:00:00Z"),
  });

  it("pages through EVERY page until nextCursor is null (no live endpoint dropped)", async () => {
    const a = mk("a", "a");
    const b = mk("b", "b");
    const c = mk("c", "c");
    const cursor = { receivedAt: new Date("2026-06-25T00:00:00Z"), id: "b" };
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [a, b], nextCursor: cursor })
      .mockResolvedValueOnce({ items: [c], nextCursor: null });
    const all = await collectAllEndpoints(fetchPage);
    expect(all).toEqual([a, b, c]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    // The second page is fetched with the first page's nextCursor (the keyset advance).
    expect(fetchPage).toHaveBeenNthCalledWith(2, cursor);
  });

  it("makes a single fetch when the first page is exhaustive", async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce({ items: [mk("a", "a")], nextCursor: null });
    expect(await collectAllEndpoints(fetchPage)).toHaveLength(1);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
