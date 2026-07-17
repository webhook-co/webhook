import { b64ToBytes, importListenTicketKey, verifyListenTicket } from "@webhook-co/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The action is the session/CSRF boundary + input guard + RLS endpoint-ownership check over the pure ticket
// codec. Mock the session gate, the endpoint loader, and the key accessor; verify the MINTED ticket with the
// real codec so the round-trip (org + endpoint bound) is proven end-to-end.
const { requireOrgAccess } = vi.hoisted(() => ({
  requireOrgAccess: vi.fn(async () => ({
    userId: "u1",
    orgId: "org-1",
    slug: "acme",
    user: { name: "A", email: "a@x.com", image: null },
  })),
}));
vi.mock("./org-access", () => ({ requireOrgAccess }));

const { loadEndpoint } = vi.hoisted(() => ({ loadEndpoint: vi.fn() }));
vi.mock("./endpoints", async (orig) => ({
  ...(await orig<typeof import("./endpoints")>()),
  loadEndpoint,
}));

const KEY_B64 = btoa("test-listen-ticket-key-32bytes!!"); // 32 chars → 32 bytes
vi.mock("./env", async (orig) => ({
  ...(await orig<typeof import("./env")>()),
  getListenTicketKey: vi.fn(async () => KEY_B64),
}));

import { mintListenTicketAction, mintOrgListenTicketAction } from "./listen-ticket-actions";

const ENDPOINT = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mintListenTicketAction", () => {
  it("mints a ticket that verifies to the session org + the endpoint", async () => {
    loadEndpoint.mockResolvedValue({ status: "ok", endpoint: { id: ENDPOINT } });
    const res = await mintListenTicketAction("acme", ENDPOINT);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.subprotocol).toBe("wbhk.listen.v1");
      const key = await importListenTicketKey(b64ToBytes(KEY_B64));
      const grant = await verifyListenTicket(key, res.ticket, Math.floor(Date.now() / 1000));
      expect(grant).toEqual({
        scope: "endpoint",
        orgId: "org-1",
        endpointId: ENDPOINT,
        userId: "u1",
      });
    }
  });

  it("refuses a non-uuid endpoint without touching the loader", async () => {
    const res = await mintListenTicketAction("acme", "not-a-uuid");
    expect(res.ok).toBe(false);
    expect(loadEndpoint).not.toHaveBeenCalled();
  });

  it("returns not-found for a cross-org / unknown endpoint (no ticket)", async () => {
    loadEndpoint.mockResolvedValue({ status: "not_found" });
    const res = await mintListenTicketAction("acme", ENDPOINT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no longer exists/i);
  });

  it("returns a generic retry error (no ticket) on a loader fault", async () => {
    loadEndpoint.mockRejectedValue(new Error("boom"));
    const res = await mintListenTicketAction("acme", ENDPOINT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/couldn't start/i);
  });

  it("returns a generic retry error when the loader reports a db fault (status: error)", async () => {
    // loadEndpoint catches its own db faults and returns {status:"error"} WITHOUT throwing.
    loadEndpoint.mockResolvedValue({ status: "error" });
    const res = await mintListenTicketAction("acme", ENDPOINT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/couldn't start/i);
  });
});

describe("mintOrgListenTicketAction", () => {
  it("mints an ORG-scoped ticket bound to the session org, with NO endpoint and NO ownership check", async () => {
    const res = await mintOrgListenTicketAction("acme");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.subprotocol).toBe("wbhk.listen.v1");
      const key = await importListenTicketKey(b64ToBytes(KEY_B64));
      const grant = await verifyListenTicket(key, res.ticket, Math.floor(Date.now() / 1000));
      expect(grant).toEqual({ scope: "org", orgId: "org-1", userId: "u1" });
    }
    // RLS is the org boundary — an org tail names no endpoint, so there is nothing to own-check.
    expect(loadEndpoint).not.toHaveBeenCalled();
  });

  it("requires org access — a caller with no session never reaches the mint", async () => {
    requireOrgAccess.mockRejectedValueOnce(new Error("no session"));
    await expect(mintOrgListenTicketAction("acme")).rejects.toThrow();
  });

  it("returns a generic retry error (no ticket) if the key can't be loaded", async () => {
    const { getListenTicketKey } = await import("./env");
    vi.mocked(getListenTicketKey).mockRejectedValueOnce(new Error("kms down"));
    const res = await mintOrgListenTicketAction("acme");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/couldn't start/i);
  });
});
