import { beforeEach, describe, expect, it, vi } from "vitest";

// The actions gate on the session; stub it so the unit runs without a cookie.
vi.mock("./org-access", () => ({
  requireOrgAccess: vi.fn(async () => ({
    userId: "u",
    orgId: "o",
    user: { name: "", email: "", image: null },
  })),
}));
// revalidatePath needs a Next request scope it doesn't have in a unit test — stub it.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// The DB-touching mutations (Lane B over the tenant pool + KV_CONFIG eviction) — mocked here; the glue is
// unit-tested in endpoint-mutations.test.ts and the db fns in the db package's integration suite.
const { createEndpoint, rotateEndpoint, deleteEndpoint, updateEndpointDedup } = vi.hoisted(() => ({
  createEndpoint: vi.fn(),
  rotateEndpoint: vi.fn(),
  deleteEndpoint: vi.fn(),
  updateEndpointDedup: vi.fn(),
}));
vi.mock("./endpoint-mutations", () => ({
  createEndpoint,
  rotateEndpoint,
  deleteEndpoint,
  updateEndpointDedup,
}));

import type { DedupConfig } from "@webhook-co/shared";

import { revalidatePath } from "next/cache";

import {
  createEndpointAction,
  deleteEndpointAction,
  rotateEndpointAction,
  updateEndpointDedupAction,
} from "./endpoint-actions";

const minted = {
  id: "ep_1",
  name: "Stripe prod",
  paused: false,
  createdAt: new Date("2026-06-25T00:00:00Z"),
  dedupConfig: null,
  ingestUrl: "https://wbhk.my/whep_abc",
};

// A valid endpoint uuid for the rotate/delete action inputs (they now reject non-uuids up front).
const ID = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060";

describe("createEndpointAction", () => {
  beforeEach(() => {
    createEndpoint.mockReset();
    createEndpoint.mockResolvedValue(minted);
  });

  it("rejects an empty name without creating", async () => {
    expect((await createEndpointAction({ name: "   " })).ok).toBe(false);
    expect(createEndpoint).not.toHaveBeenCalled();
  });

  it("rejects a non-string name without throwing (crafted payload)", async () => {
    const result = await createEndpointAction({ name: 123 } as unknown as { name: string });
    expect(result.ok).toBe(false);
    expect(createEndpoint).not.toHaveBeenCalled();
  });

  it("accepts a 200-char name (parity with the contract max) but rejects 201", async () => {
    expect((await createEndpointAction({ name: "x".repeat(200) })).ok).toBe(true);
    createEndpoint.mockClear();
    const result = await createEndpointAction({ name: "x".repeat(201) });
    expect(result.ok).toBe(false);
    expect(createEndpoint).not.toHaveBeenCalled();
  });

  it("surfaces the RATE_LIMITED cap distinctly (not a generic 'try again')", async () => {
    createEndpoint.mockRejectedValue(
      Object.assign(new Error("endpoint limit reached"), {
        name: "CapabilityFault",
        code: "RATE_LIMITED",
      }),
    );
    const result = await createEndpointAction({ name: "k" });
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/limit/i) });
  });

  it("creates with the session principal and returns the endpoint + one-time ingest URL", async () => {
    const result = await createEndpointAction({ name: "  Stripe prod  " });
    expect(createEndpoint).toHaveBeenCalledWith({ orgId: "o", userId: "u", name: "Stripe prod" });
    expect(result).toEqual({
      ok: true,
      endpoint: {
        id: "ep_1",
        name: "Stripe prod",
        paused: false,
        createdAt: minted.createdAt,
        dedupConfig: null,
      },
      ingestUrl: "https://wbhk.my/whep_abc",
    });
  });

  it("threads a valid dedup config through to the mutation", async () => {
    const dedupConfig: DedupConfig = { mode: "content", windowSeconds: 3600 };
    await createEndpointAction({ name: "GitHub", dedupConfig });
    expect(createEndpoint).toHaveBeenCalledWith({
      orgId: "o",
      userId: "u",
      name: "GitHub",
      dedupConfig,
    });
  });

  it("rejects an invalid dedup config without creating", async () => {
    // fields mode with no include list is rejected by the schema's superRefine — a crafted payload must not
    // reach the db.
    const result = await createEndpointAction({
      name: "GitHub",
      dedupConfig: { mode: "fields", windowSeconds: 3600 } as unknown as DedupConfig,
    });
    expect(result.ok).toBe(false);
    expect(createEndpoint).not.toHaveBeenCalled();
  });

  it("surfaces a generic error (no throw) when the create fails", async () => {
    createEndpoint.mockRejectedValue(new Error("db down"));
    const result = await createEndpointAction({ name: "k" });
    expect(result.ok).toBe(false);
  });
});

describe("updateEndpointDedupAction", () => {
  const config: DedupConfig = { mode: "content", windowSeconds: 3600 };

  beforeEach(() => {
    updateEndpointDedup.mockReset();
    updateEndpointDedup.mockResolvedValue({ dedupConfig: config });
    vi.mocked(revalidatePath).mockReset();
  });

  it("rejects a missing id without mutating", async () => {
    expect((await updateEndpointDedupAction({ endpointId: "  ", dedupConfig: config })).ok).toBe(
      false,
    );
    expect(updateEndpointDedup).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid id as gone, without mutating", async () => {
    expect(
      await updateEndpointDedupAction({ endpointId: "not-a-uuid", dedupConfig: config }),
    ).toEqual({ ok: false, error: expect.stringMatching(/no longer exists/i) });
    expect(updateEndpointDedup).not.toHaveBeenCalled();
  });

  it("rejects an invalid dedup config (crafted payload) without mutating", async () => {
    const result = await updateEndpointDedupAction({
      endpointId: ID,
      // fields mode requires a non-empty include list — the schema rejects this.
      dedupConfig: { mode: "fields", windowSeconds: 3600 } as unknown as DedupConfig,
    });
    expect(result.ok).toBe(false);
    expect(updateEndpointDedup).not.toHaveBeenCalled();
  });

  it("accepts a null config (reset to default) and revalidates the detail page", async () => {
    updateEndpointDedup.mockResolvedValue({ dedupConfig: null });
    const result = await updateEndpointDedupAction({ endpointId: ID, dedupConfig: null });
    expect(updateEndpointDedup).toHaveBeenCalledWith({
      orgId: "o",
      userId: "u",
      endpointId: ID,
      dedupConfig: null,
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/endpoints/${ID}`);
    expect(result).toEqual({ ok: true, dedupConfig: null });
  });

  it("updates with the session principal and returns the applied config", async () => {
    const result = await updateEndpointDedupAction({ endpointId: ID, dedupConfig: config });
    expect(updateEndpointDedup).toHaveBeenCalledWith({
      orgId: "o",
      userId: "u",
      endpointId: ID,
      dedupConfig: config,
    });
    expect(result).toEqual({ ok: true, dedupConfig: config });
  });

  it("surfaces NOT_FOUND distinctly when the endpoint is gone", async () => {
    updateEndpointDedup.mockRejectedValue(
      Object.assign(new Error("endpoint not found"), {
        name: "CapabilityFault",
        code: "NOT_FOUND",
      }),
    );
    expect(await updateEndpointDedupAction({ endpointId: ID, dedupConfig: config })).toEqual({
      ok: false,
      error: expect.stringMatching(/no longer exists/i),
    });
  });

  it("still returns ok when the post-update revalidation throws (best-effort)", async () => {
    vi.mocked(revalidatePath).mockImplementationOnce(() => {
      throw new Error("revalidate boom");
    });
    expect(await updateEndpointDedupAction({ endpointId: ID, dedupConfig: config })).toEqual({
      ok: true,
      dedupConfig: config,
    });
  });

  it("surfaces a generic error (no throw) when the update fails", async () => {
    updateEndpointDedup.mockRejectedValue(new Error("db down"));
    expect((await updateEndpointDedupAction({ endpointId: ID, dedupConfig: config })).ok).toBe(
      false,
    );
  });
});

describe("rotateEndpointAction", () => {
  beforeEach(() => {
    rotateEndpoint.mockReset();
    rotateEndpoint.mockResolvedValue(minted);
  });

  it("rejects a missing id without rotating", async () => {
    expect((await rotateEndpointAction("  ")).ok).toBe(false);
    expect(rotateEndpoint).not.toHaveBeenCalled();
  });

  it("rejects a non-string id without throwing (crafted payload)", async () => {
    const result = await rotateEndpointAction(123 as unknown as string);
    expect(result.ok).toBe(false);
    expect(rotateEndpoint).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid id as gone, without rotating", async () => {
    expect(await rotateEndpointAction("not-a-uuid")).toEqual({
      ok: false,
      error: expect.stringMatching(/no longer exists/i),
    });
    expect(rotateEndpoint).not.toHaveBeenCalled();
  });

  it("returns the new one-time ingest URL on success", async () => {
    const result = await rotateEndpointAction(ID);
    expect(rotateEndpoint).toHaveBeenCalledWith({ orgId: "o", userId: "u", endpointId: ID });
    expect(result).toEqual({ ok: true, ingestUrl: "https://wbhk.my/whep_abc" });
  });

  it("surfaces NOT_FOUND distinctly when the endpoint is gone", async () => {
    rotateEndpoint.mockRejectedValue(
      Object.assign(new Error("endpoint not found"), {
        name: "CapabilityFault",
        code: "NOT_FOUND",
      }),
    );
    expect(await rotateEndpointAction(ID)).toEqual({
      ok: false,
      error: expect.stringMatching(/no longer exists/i),
    });
  });

  it("surfaces a generic error (no throw) when the rotate fails", async () => {
    rotateEndpoint.mockRejectedValue(new Error("db down"));
    expect((await rotateEndpointAction(ID)).ok).toBe(false);
  });
});

describe("deleteEndpointAction", () => {
  beforeEach(() => {
    deleteEndpoint.mockReset();
    deleteEndpoint.mockResolvedValue(undefined);
  });

  it("rejects a missing id without deleting", async () => {
    expect((await deleteEndpointAction("")).ok).toBe(false);
    expect(deleteEndpoint).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid id as gone, without deleting", async () => {
    expect(await deleteEndpointAction("not-a-uuid")).toEqual({
      ok: false,
      error: expect.stringMatching(/no longer exists/i),
    });
    expect(deleteEndpoint).not.toHaveBeenCalled();
  });

  it("soft-deletes via the session principal and returns ok", async () => {
    const result = await deleteEndpointAction(ID);
    expect(deleteEndpoint).toHaveBeenCalledWith({ orgId: "o", userId: "u", endpointId: ID });
    expect(result).toEqual({ ok: true });
  });

  it("still returns ok when the post-delete cache revalidation throws (best-effort)", async () => {
    // A revalidatePath failure must NOT flip a committed soft-delete into a reported failure — the
    // endpoint is already deleted, so reporting ok:false would tell the user it's still live.
    vi.mocked(revalidatePath).mockImplementationOnce(() => {
      throw new Error("revalidate boom");
    });
    expect(await deleteEndpointAction(ID)).toEqual({ ok: true });
    expect(deleteEndpoint).toHaveBeenCalledWith({ orgId: "o", userId: "u", endpointId: ID });
  });

  it("surfaces NOT_FOUND distinctly when the endpoint is gone", async () => {
    deleteEndpoint.mockRejectedValue(
      Object.assign(new Error("endpoint not found"), {
        name: "CapabilityFault",
        code: "NOT_FOUND",
      }),
    );
    expect(await deleteEndpointAction(ID)).toEqual({
      ok: false,
      error: expect.stringMatching(/no longer exists/i),
    });
  });

  it("surfaces a generic error (no throw) when the delete fails", async () => {
    deleteEndpoint.mockRejectedValue(new Error("db down"));
    expect((await deleteEndpointAction(ID)).ok).toBe(false);
  });
});
