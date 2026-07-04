import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the session gate + the mutations seam + the loader; the action layer is the CSRF/session boundary +
// the input guard + the error taxonomy, so we test THAT in isolation.
const { verifySession } = vi.hoisted(() => ({
  verifySession: vi.fn(async () => ({
    userId: "user-1",
    orgId: "org-1",
    user: { name: "A", email: "a@x.com", image: null },
  })),
}));
vi.mock("./session", () => ({ verifySession }));

const { mutations, InvalidDestinationUrlError, SealerUnavailableError } = vi.hoisted(() => {
  class InvalidDestinationUrlError extends Error {
    constructor(readonly reason: string) {
      super(reason);
      this.name = "InvalidDestinationUrlError";
    }
  }
  class SealerUnavailableError extends Error {
    constructor() {
      super("no sealer");
      this.name = "SealerUnavailableError";
    }
  }
  return {
    mutations: {
      createDestination: vi.fn(),
      removeDestination: vi.fn(),
      enableDestination: vi.fn(),
      setDestinationOrdered: vi.fn(),
      rotateDestinationSecret: vi.fn(),
    },
    InvalidDestinationUrlError,
    SealerUnavailableError,
  };
});
vi.mock("./replay-destination-mutations", () => ({
  ...mutations,
  InvalidDestinationUrlError,
  SealerUnavailableError,
}));

const { loadSigningSecrets } = vi.hoisted(() => ({ loadSigningSecrets: vi.fn() }));
vi.mock("./replay-destinations", async (orig) => ({
  ...(await orig<typeof import("./replay-destinations")>()),
  loadSigningSecrets,
}));

const { logActionError } = vi.hoisted(() => ({ logActionError: vi.fn() }));
vi.mock("./action-log", () => ({ logActionError }));

import {
  createDestinationAction,
  deleteDestinationAction,
  enableDestinationAction,
  listDestinationSecretsAction,
  rotateDestinationSecretAction,
  setDestinationOrderedAction,
} from "./replay-destination-actions";

const REC = {
  id: "11111111-1111-1111-1111-111111111111",
  orgId: "org-1",
  url: "https://hooks.example.com/in",
  label: "prod" as string | null,
  status: "active" as const,
  createdAt: new Date("2026-07-01T00:00:00Z"),
  lastValidatedAt: null,
  ordered: false,
  disabledAt: null as Date | null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createDestinationAction", () => {
  it("returns ok with a stripped item + the one-time signing secret on a fresh create", async () => {
    mutations.createDestination.mockResolvedValue({ record: REC, signingSecret: "whsec_fresh" });
    const res = await createDestinationAction({
      url: "https://hooks.example.com/in",
      label: "prod",
    });
    expect(res).toEqual({
      ok: true,
      destination: expect.not.objectContaining({ orgId: expect.anything() }),
      signingSecret: "whsec_fresh",
    });
    if (res.ok) expect(res.destination.id).toBe(REC.id);
  });

  it("omits the secret on an idempotent re-add (already registered)", async () => {
    mutations.createDestination.mockResolvedValue({ record: REC, signingSecret: undefined });
    const res = await createDestinationAction({ url: "https://hooks.example.com/in" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.signingSecret).toBeUndefined();
  });

  it("rejects a non-string url without calling the mutation", async () => {
    const res = await createDestinationAction({ url: 123 as unknown as string });
    expect(res.ok).toBe(false);
    expect(mutations.createDestination).not.toHaveBeenCalled();
  });

  it("maps an InvalidDestinationUrlError to honest, structural copy (never 'malicious')", async () => {
    mutations.createDestination.mockRejectedValue(
      new InvalidDestinationUrlError("ip_literal_host"),
    );
    const res = await createDestinationAction({ url: "https://169.254.169.254" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/IP address/i);
      expect(res.error).not.toMatch(/malicious|attack/i);
    }
  });

  it("fails closed on a missing sealer", async () => {
    mutations.createDestination.mockRejectedValue(new SealerUnavailableError());
    const res = await createDestinationAction({ url: "https://hooks.example.com/in" });
    expect(res.ok).toBe(false);
  });

  it("never passes a secret to the scrubbed logger on failure", async () => {
    mutations.createDestination.mockRejectedValue(new Error("boom"));
    await createDestinationAction({ url: "https://hooks.example.com/in" });
    // The logger is called with (event, error) only — never the input/url/secret.
    for (const call of logActionError.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("whsec_");
    }
  });
});

describe("rotateDestinationSecretAction", () => {
  it("returns the one-time rotated secret", async () => {
    mutations.rotateDestinationSecret.mockResolvedValue({ keyId: "k2", secret: "whsec_rot" });
    const res = await rotateDestinationSecretAction(REC.id);
    expect(res).toEqual({ ok: true, signingSecret: "whsec_rot" });
  });

  it("rejects a non-uuid as gone (no db 22P02)", async () => {
    const res = await rotateDestinationSecretAction("not-a-uuid");
    expect(res.ok).toBe(false);
    expect(mutations.rotateDestinationSecret).not.toHaveBeenCalled();
  });

  it("maps a null (soft-deleted / not-live destination) to a clean NOT_FOUND error", async () => {
    mutations.rotateDestinationSecret.mockResolvedValue(null);
    const res = await rotateDestinationSecretAction(REC.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no longer exists/i);
  });
});

describe("enable / setOrdered / delete", () => {
  it("enableDestinationAction returns the updated stripped item", async () => {
    mutations.enableDestination.mockResolvedValue({ ...REC, disabledAt: null });
    const res = await enableDestinationAction(REC.id);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.destination).not.toHaveProperty("orgId");
  });

  it("enableDestinationAction maps a null (not found) to a clean error", async () => {
    mutations.enableDestination.mockResolvedValue(null);
    const res = await enableDestinationAction(REC.id);
    expect(res.ok).toBe(false);
  });

  it("setDestinationOrderedAction threads the ordered flag", async () => {
    mutations.setDestinationOrdered.mockResolvedValue({ ...REC, ordered: true });
    const res = await setDestinationOrderedAction(REC.id, true);
    expect(res.ok).toBe(true);
    expect(mutations.setDestinationOrdered).toHaveBeenCalledWith(
      expect.objectContaining({ destinationId: REC.id, ordered: true }),
    );
  });

  it("deleteDestinationAction maps a null (not found) to a clean error", async () => {
    mutations.removeDestination.mockResolvedValue(null);
    const res = await deleteDestinationAction(REC.id);
    expect(res.ok).toBe(false);
  });

  it("deleteDestinationAction returns ok on success", async () => {
    mutations.removeDestination.mockResolvedValue({ id: REC.id, deletedAt: new Date() });
    const res = await deleteDestinationAction(REC.id);
    expect(res.ok).toBe(true);
  });
});

describe("listDestinationSecretsAction", () => {
  it("returns metadata on ok", async () => {
    loadSigningSecrets.mockResolvedValue({
      status: "ok",
      items: [{ id: "k1", status: "active", createdAt: new Date() }],
    });
    const res = await listDestinationSecretsAction(REC.id);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.items).toHaveLength(1);
  });

  it("maps a loader error to {ok:false}", async () => {
    loadSigningSecrets.mockResolvedValue({ status: "error" });
    const res = await listDestinationSecretsAction(REC.id);
    expect(res.ok).toBe(false);
  });

  it("maps a not_found (soft-deleted destination) to a clean error", async () => {
    loadSigningSecrets.mockResolvedValue({ status: "not_found" });
    const res = await listDestinationSecretsAction(REC.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no longer exists/i);
  });

  it("rejects a non-uuid id", async () => {
    const res = await listDestinationSecretsAction("nope");
    expect(res.ok).toBe(false);
    expect(loadSigningSecrets).not.toHaveBeenCalled();
  });
});
