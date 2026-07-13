import { CapabilityFault } from "@webhook-co/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the session gate + the mutations seam; the action layer is the CSRF/session boundary + the input
// guard + the error taxonomy, so we test THAT in isolation.
const { requireOrgAccess } = vi.hoisted(() => ({
  requireOrgAccess: vi.fn(async () => ({
    userId: "user-1",
    orgId: "org-1",
    // The CANONICAL slug the gate resolved. revalidatePath is built from THIS, never the raw URL segment.
    slug: "acme",
    user: { name: "A", email: "a@x.com", image: null },
  })),
}));
vi.mock("./org-access", () => ({ requireOrgAccess }));

const { mutations, TriggerEndpointNotFoundError } = vi.hoisted(() => {
  class TriggerEndpointNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "TriggerEndpointNotFoundError";
    }
  }
  return {
    mutations: { createTrigger: vi.fn(), revokeTrigger: vi.fn() },
    TriggerEndpointNotFoundError,
  };
});
vi.mock("./agent-trigger-mutations", () => ({ ...mutations, TriggerEndpointNotFoundError }));

const { logActionError } = vi.hoisted(() => ({ logActionError: vi.fn() }));
vi.mock("./action-log", () => ({ logActionError }));

const { revalidatePath } = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath }));

import { createTriggerAction, revokeTriggerAction } from "./agent-trigger-actions";

const EP = "22222222-2222-4222-8222-222222222222";
const TRIG = "11111111-1111-4111-8111-111111111111";
const record = () => ({
  id: TRIG,
  orgId: "org-1",
  endpointId: EP,
  name: "agent",
  createdAt: new Date(0),
  revokedAt: null,
});

beforeEach(() => vi.clearAllMocks());

describe("createTriggerAction", () => {
  it("creates a trigger (orgId + actor from the session), strips orgId, revalidates", async () => {
    mutations.createTrigger.mockResolvedValueOnce(record());
    const res = await createTriggerAction("acme", { endpointId: EP, name: "agent" });
    expect(res).toEqual({
      ok: true,
      trigger: expect.not.objectContaining({ orgId: expect.anything() }),
    });
    expect(mutations.createTrigger).toHaveBeenCalledWith({
      orgId: "org-1",
      endpointId: EP,
      name: "agent",
      actor: "user-1",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/org/acme/triggers");
  });

  it("rejects a non-uuid endpoint id WITHOUT calling the mutation", async () => {
    const res = await createTriggerAction("acme", { endpointId: "not-a-uuid" });
    expect(res).toEqual({ ok: false, error: "Choose an endpoint." });
    expect(mutations.createTrigger).not.toHaveBeenCalled();
  });

  it("rejects an over-long label", async () => {
    const res = await createTriggerAction("acme", { endpointId: EP, name: "x".repeat(101) });
    expect(res.ok).toBe(false);
    expect(mutations.createTrigger).not.toHaveBeenCalled();
  });

  it("maps an endpoint-not-found to a no-leak message", async () => {
    mutations.createTrigger.mockRejectedValueOnce(new TriggerEndpointNotFoundError("gone"));
    const res = await createTriggerAction("acme", { endpointId: EP });
    expect(res).toEqual({ ok: false, error: "That endpoint no longer exists." });
  });

  it("maps the per-org RATE_LIMITED cap to friendly copy", async () => {
    mutations.createTrigger.mockRejectedValueOnce(new CapabilityFault("RATE_LIMITED", "cap"));
    const res = await createTriggerAction("acme", { endpointId: EP });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.error).toMatch(/active-trigger limit/i);
  });

  it("maps any other failure to a generic message (scrubbed)", async () => {
    mutations.createTrigger.mockRejectedValueOnce(new Error("db boom"));
    const res = await createTriggerAction("acme", { endpointId: EP });
    expect(res).toEqual({ ok: false, error: "We couldn't create the trigger. Please try again." });
    expect(logActionError).toHaveBeenCalledWith("triggers.create_failed", expect.any(Error));
  });
});

describe("revokeTriggerAction", () => {
  it("revokes and revalidates", async () => {
    mutations.revokeTrigger.mockResolvedValueOnce({ id: TRIG });
    const res = await revokeTriggerAction("acme", TRIG);
    expect(res).toEqual({ ok: true });
    expect(mutations.revokeTrigger).toHaveBeenCalledWith({
      orgId: "org-1",
      triggerId: TRIG,
      actor: "user-1",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/org/acme/triggers");
  });

  it("rejects a non-uuid id WITHOUT calling the mutation", async () => {
    const res = await revokeTriggerAction("acme", "nope");
    expect(res).toEqual({ ok: false, error: "That trigger no longer exists." });
    expect(mutations.revokeTrigger).not.toHaveBeenCalled();
  });

  it("maps a null (unknown / cross-org) to a no-leak NOT_FOUND message, no revalidate", async () => {
    mutations.revokeTrigger.mockResolvedValueOnce(null);
    const res = await revokeTriggerAction("acme", TRIG);
    expect(res).toEqual({ ok: false, error: "That trigger no longer exists." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
