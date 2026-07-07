import { describe, expect, it, vi } from "vitest";

import type { DedupConfig } from "@webhook-co/shared";

import {
  createEndpoint,
  deleteEndpoint,
  normalizeIngestApex,
  rotateEndpoint,
  updateEndpointDedup,
  type EndpointMutationDeps,
} from "./endpoint-mutations";

const createdAt = new Date("2026-06-25T00:00:00Z");

function fakeDeps(over: Partial<EndpointMutationDeps> = {}): EndpointMutationDeps {
  return {
    create: vi.fn(async (_o, name, _a, dedupConfig) => ({
      id: "ep_1",
      name,
      paused: false,
      createdAt,
      dedupConfig,
      plaintext: "whep_new",
    })),
    rotate: vi.fn(async (_o, id) => ({
      id,
      name: "n",
      paused: false,
      createdAt,
      dedupConfig: null,
      oldTokenHash: Buffer.from("old"),
      plaintext: "whep_rot",
    })),
    update: vi.fn(async (_o, _id, dedupConfig) => ({
      tokenHash: Buffer.from("upd"),
      dedupConfig,
    })),
    remove: vi.fn(async () => ({ tokenHash: Buffer.from("del") })),
    evict: vi.fn(async () => {}),
    apex: vi.fn(() => "https://wbhk.my"),
    ...over,
  };
}

const contentConfig: DedupConfig = { mode: "content", windowSeconds: 3600 };

describe("normalizeIngestApex", () => {
  it("returns the bare origin for a valid apex", () => {
    expect(normalizeIngestApex("https://wbhk.my")).toBe("https://wbhk.my");
    expect(normalizeIngestApex("https://wbhk.my/")).toBe("https://wbhk.my");
  });

  it("throws fail-closed on a non-url / non-http(s) / path-bearing value", () => {
    expect(() => normalizeIngestApex("not a url")).toThrow();
    expect(() => normalizeIngestApex("ftp://wbhk.my")).toThrow();
    expect(() => normalizeIngestApex("https://wbhk.my/path")).toThrow();
    expect(() => normalizeIngestApex("https://wbhk.my?q=1")).toThrow();
  });
});

describe("createEndpoint", () => {
  it("validates the apex BEFORE minting and builds the one-time ingest URL", async () => {
    const order: string[] = [];
    const deps = fakeDeps({
      apex: vi.fn(() => {
        order.push("apex");
        return "https://wbhk.my";
      }),
      create: vi.fn(async (_o, name) => {
        order.push("create");
        return { id: "ep_1", name, paused: false, createdAt, plaintext: "whep_new" };
      }),
    });
    const result = await createEndpoint({ orgId: "o", userId: "u", name: "Stripe" }, deps);
    expect(order).toEqual(["apex", "create"]); // fail-closed apex check precedes the mint
    expect(deps.create).toHaveBeenCalledWith("o", "Stripe", "u", null); // no config -> null default
    expect(result.ingestUrl).toBe("https://wbhk.my/whep_new");
    expect(result.dedupConfig).toBeNull();
  });

  it("threads a supplied dedup config into the mint and echoes it back", async () => {
    const deps = fakeDeps();
    const result = await createEndpoint(
      { orgId: "o", userId: "u", name: "Stripe", dedupConfig: contentConfig },
      deps,
    );
    expect(deps.create).toHaveBeenCalledWith("o", "Stripe", "u", contentConfig);
    expect(result.dedupConfig).toEqual(contentConfig);
  });

  it("does not evict on create (no old token to drop)", async () => {
    const deps = fakeDeps();
    await createEndpoint({ orgId: "o", userId: "u", name: "x" }, deps);
    expect(deps.evict).not.toHaveBeenCalled();
  });
});

describe("updateEndpointDedup", () => {
  it("updates the config then evicts the endpoint's token hash with the 'update' verb", async () => {
    const deps = fakeDeps();
    const result = await updateEndpointDedup(
      { orgId: "o", userId: "u", endpointId: "ep_1", dedupConfig: contentConfig },
      deps,
    );
    expect(deps.update).toHaveBeenCalledWith("o", "ep_1", contentConfig, "u");
    expect(deps.evict).toHaveBeenCalledWith(Buffer.from("upd"), "update");
    expect(result.dedupConfig).toEqual(contentConfig);
  });

  it("passes a null config through (resets to the default)", async () => {
    const deps = fakeDeps();
    const result = await updateEndpointDedup(
      { orgId: "o", userId: "u", endpointId: "ep_1", dedupConfig: null },
      deps,
    );
    expect(deps.update).toHaveBeenCalledWith("o", "ep_1", null, "u");
    expect(result.dedupConfig).toBeNull();
  });

  it("still resolves when the best-effort evict throws (the update is already committed)", async () => {
    // The evict runs AFTER the committed update — a KV blip must NOT throw out of the mutation, else a
    // persisted config change would be reported as a failure. The db is the source of truth; the stale
    // cached principal self-heals on its TTL regardless.
    const deps = fakeDeps({
      update: vi.fn(async (_o, _id, dedupConfig) => ({
        tokenHash: Buffer.from("upd"),
        dedupConfig,
      })),
      evict: vi.fn(async () => {
        throw new Error("kv down");
      }),
    });
    await expect(
      updateEndpointDedup(
        { orgId: "o", userId: "u", endpointId: "ep_1", dedupConfig: contentConfig },
        deps,
      ),
    ).resolves.toEqual({ dedupConfig: contentConfig });
  });
});

describe("rotateEndpoint", () => {
  it("evicts the OLD token hash (hard cut) and returns the NEW one-time URL", async () => {
    const deps = fakeDeps();
    const result = await rotateEndpoint({ orgId: "o", userId: "u", endpointId: "ep_1" }, deps);
    expect(deps.rotate).toHaveBeenCalledWith("o", "ep_1", "u");
    expect(deps.evict).toHaveBeenCalledWith(Buffer.from("old"), "rotate");
    expect(result.ingestUrl).toBe("https://wbhk.my/whep_rot");
  });
});

describe("deleteEndpoint", () => {
  it("soft-deletes then evicts the token hash (no reveal)", async () => {
    const deps = fakeDeps();
    const result = await deleteEndpoint({ orgId: "o", userId: "u", endpointId: "ep_1" }, deps);
    expect(deps.remove).toHaveBeenCalledWith("o", "ep_1", "u");
    expect(deps.evict).toHaveBeenCalledWith(Buffer.from("del"), "delete");
    expect(result).toBeUndefined();
  });
});
