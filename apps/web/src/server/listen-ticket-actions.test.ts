import { b64ToBytes, importListenTicketKey, verifyListenTicket } from "@webhook-co/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The action is the session/CSRF boundary + input guard + RLS endpoint-ownership check over the pure ticket
// codec. Mock the session gate, the endpoint loader, and the key accessor; verify the MINTED ticket with the
// real codec so the round-trip (org + endpoint bound) is proven end-to-end.
const { requireOrgAccess } = vi.hoisted(() => ({
  requireOrgAccess: vi.fn(async () => ({
    userId: "u1",
    orgId: "org-1",
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

import { mintListenTicketAction } from "./listen-ticket-actions";

const ENDPOINT = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mintListenTicketAction", () => {
  it("mints a ticket that verifies to the session org + the endpoint", async () => {
    loadEndpoint.mockResolvedValue({ status: "ok", endpoint: { id: ENDPOINT } });
    const res = await mintListenTicketAction(ENDPOINT);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.subprotocol).toBe("wbhk.listen.v1");
      const key = await importListenTicketKey(b64ToBytes(KEY_B64));
      const grant = await verifyListenTicket(key, res.ticket, Math.floor(Date.now() / 1000));
      expect(grant).toEqual({ orgId: "org-1", endpointId: ENDPOINT, userId: "u1" });
    }
  });

  it("refuses a non-uuid endpoint without touching the loader", async () => {
    const res = await mintListenTicketAction("not-a-uuid");
    expect(res.ok).toBe(false);
    expect(loadEndpoint).not.toHaveBeenCalled();
  });

  it("returns not-found for a cross-org / unknown endpoint (no ticket)", async () => {
    loadEndpoint.mockResolvedValue({ status: "not_found" });
    const res = await mintListenTicketAction(ENDPOINT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no longer exists/i);
  });

  it("returns a generic retry error (no ticket) on a loader fault", async () => {
    loadEndpoint.mockRejectedValue(new Error("boom"));
    const res = await mintListenTicketAction(ENDPOINT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/couldn't start/i);
  });

  it("returns a generic retry error when the loader reports a db fault (status: error)", async () => {
    // loadEndpoint catches its own db faults and returns {status:"error"} WITHOUT throwing.
    loadEndpoint.mockResolvedValue({ status: "error" });
    const res = await mintListenTicketAction(ENDPOINT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/couldn't start/i);
  });
});
