import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the session gate + the mutations seam; the action layer is the CSRF/session boundary + the input
// guard + the error taxonomy, so we test THAT in isolation. vi.hoisted lifts the mock fns above the hoisted
// vi.mock factory (the repo's vitest requires this).
const { requireOrgAccess } = vi.hoisted(() => ({
  requireOrgAccess: vi.fn(async () => ({
    userId: "user-1",
    orgId: "org-1",
    // The CANONICAL slug the gate resolved — every revalidatePath below is built from it.
    slug: "acme",
    user: { name: "A", email: "a@x.com", image: null },
  })),
}));
vi.mock("./org-access", () => ({ requireOrgAccess }));

const { mutations, SealerUnavailableError } = vi.hoisted(() => {
  class SealerUnavailableError extends Error {
    constructor() {
      super("no sealer");
      this.name = "SealerUnavailableError";
    }
  }
  return {
    mutations: {
      addSecret: vi.fn(),
      revokeSecret: vi.fn(),
    },
    SealerUnavailableError,
  };
});
vi.mock("./provider-secret-mutations", () => ({ ...mutations, SealerUnavailableError }));

const { logActionError } = vi.hoisted(() => ({ logActionError: vi.fn() }));
vi.mock("./action-log", () => ({ logActionError }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { addProviderSecretAction, revokeProviderSecretAction } from "./provider-secret-actions";

// A duck-typed CapabilityFault like the write core throws.
class CapabilityFault extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CapabilityFault";
  }
}

const ENDPOINT = "11111111-1111-1111-1111-111111111111";
const SECRET_ID = "33333333-3333-3333-3333-333333333333";

function validInput(over: Record<string, unknown> = {}) {
  return {
    endpointId: ENDPOINT,
    provider: "stripe",
    kind: "signing_secret",
    secret: "whsec_abc",
    ...over,
  } as Parameters<typeof addProviderSecretAction>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("addProviderSecretAction — input guards", () => {
  it("rejects a non-uuid endpoint before touching the mutation", async () => {
    const res = await addProviderSecretAction("acme", validInput({ endpointId: "not-a-uuid" }));
    expect(res.ok).toBe(false);
    expect(mutations.addSecret).not.toHaveBeenCalled();
  });

  it("rejects a non-string secret before touching the mutation", async () => {
    const res = await addProviderSecretAction("acme", validInput({ secret: 123 }));
    expect(res.ok).toBe(false);
    expect(mutations.addSecret).not.toHaveBeenCalled();
  });

  it("rejects an oversize secret (> 4096) before touching the mutation", async () => {
    const res = await addProviderSecretAction("acme", validInput({ secret: "x".repeat(4097) }));
    expect(res.ok).toBe(false);
    expect(mutations.addSecret).not.toHaveBeenCalled();
  });

  it("rejects an unknown kind before touching the mutation", async () => {
    const res = await addProviderSecretAction("acme", validInput({ kind: "nope" }));
    expect(res.ok).toBe(false);
    expect(mutations.addSecret).not.toHaveBeenCalled();
  });

  it("rejects an empty provider before touching the mutation", async () => {
    const res = await addProviderSecretAction("acme", validInput({ provider: "  " }));
    expect(res.ok).toBe(false);
    expect(mutations.addSecret).not.toHaveBeenCalled();
  });
});

describe("addProviderSecretAction — success + fault mapping", () => {
  it("returns only non-secret metadata ({id, provider, status}) on success", async () => {
    mutations.addSecret.mockResolvedValue({ id: SECRET_ID, provider: "stripe", status: "active" });
    const res = await addProviderSecretAction("acme", validInput());
    expect(res).toEqual({
      ok: true,
      secret: { id: SECRET_ID, provider: "stripe", status: "active" },
    });
    // The result carries no secret material.
    if (res.ok) expect(JSON.stringify(res)).not.toContain("whsec_abc");
  });

  it("maps NOT_FOUND to a clean 'endpoint no longer exists' message", async () => {
    mutations.addSecret.mockRejectedValue(new CapabilityFault("NOT_FOUND", "endpoint not found"));
    const res = await addProviderSecretAction("acme", validInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no longer exists/i);
  });

  it("surfaces the VALIDATION_ERROR shape message verbatim", async () => {
    mutations.addSecret.mockRejectedValue(
      new CapabilityFault(
        "VALIDATION_ERROR",
        "a Standard Webhooks secret must be base64 key material (optionally whsec_-prefixed)",
      ),
    );
    const res = await addProviderSecretAction("acme", validInput({ secret: "not-base64" }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/base64 key material/i);
  });

  it("maps RATE_LIMITED to the per-endpoint-limit message", async () => {
    mutations.addSecret.mockRejectedValue(new CapabilityFault("RATE_LIMITED", "cap reached"));
    const res = await addProviderSecretAction("acme", validInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/limit/i);
  });

  it("maps a missing sealer to the storage-unavailable message", async () => {
    mutations.addSecret.mockRejectedValue(new SealerUnavailableError());
    const res = await addProviderSecretAction("acme", validInput());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unavailable/i);
  });

  it("never passes the input/secret to the scrubbed logger on failure", async () => {
    mutations.addSecret.mockRejectedValue(new Error("boom"));
    await addProviderSecretAction("acme", validInput({ secret: "whsec_super_secret" }));
    for (const call of logActionError.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("whsec_super_secret");
    }
  });
});

describe("revokeProviderSecretAction", () => {
  it("returns ok on a successful revoke", async () => {
    mutations.revokeSecret.mockResolvedValue({ id: SECRET_ID, revokedAt: new Date() });
    const res = await revokeProviderSecretAction("acme", ENDPOINT, SECRET_ID);
    expect(res.ok).toBe(true);
  });

  it("maps a null (not found) to a clean error flagged `gone` for row reconciliation", async () => {
    mutations.revokeSecret.mockResolvedValue(null);
    const res = await revokeProviderSecretAction("acme", ENDPOINT, SECRET_ID);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/no longer exists/i);
      expect(res.gone).toBe(true);
    }
  });

  it("rejects a non-uuid endpoint or secret id without touching the mutation, flagged `gone`", async () => {
    const res1 = await revokeProviderSecretAction("acme", "nope", SECRET_ID);
    const res2 = await revokeProviderSecretAction("acme", ENDPOINT, "nope");
    expect(res1.ok).toBe(false);
    expect(res2.ok).toBe(false);
    if (!res1.ok) expect(res1.gone).toBe(true);
    if (!res2.ok) expect(res2.gone).toBe(true);
    expect(mutations.revokeSecret).not.toHaveBeenCalled();
  });
});
