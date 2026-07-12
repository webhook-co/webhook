import { beforeEach, describe, expect, it, vi } from "vitest";

const requireOrgAccess = vi.fn();
vi.mock("./org-access", () => ({ requireOrgAccess: () => requireOrgAccess() }));

const listOrgMembers = vi.fn();
vi.mock("@webhook-co/db/members", () => ({
  listOrgMembers: (...a: unknown[]) => listOrgMembers(...a),
}));

const listPendingInvites = vi.fn();
vi.mock("@webhook-co/db/invites", () => ({
  listPendingInvites: (...a: unknown[]) => listPendingInvites(...a),
}));

// withTenantDb(fn) → fn(app); the db reads are mocked, so app is a stub.
vi.mock("./db", () => ({ withTenantDb: (fn: (app: unknown) => unknown) => fn({}) }));

import { loadTeam } from "./team";

const MEMBER = {
  userId: "u_bob",
  name: "Bob",
  email: "bob@acme.test",
  role: "member" as const,
  joinedAt: "2026-07-01T00:00:00.000Z",
};

const INVITE = {
  id: "inv_1",
  invitedEmail: "carol@acme.test",
  role: "member" as const,
  start: "whinv_ab",
  expiresAt: "2026-07-19T00:00:00.000Z",
  createdAt: "2026-07-12T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  requireOrgAccess.mockResolvedValue({
    userId: "u_owner",
    orgId: "org_1",
    role: "owner",
    user: { name: "O", email: "o@acme.test", image: null },
  });
  listOrgMembers.mockResolvedValue([MEMBER]);
  listPendingInvites.mockResolvedValue([INVITE]);
});

describe("loadTeam", () => {
  it("returns the caller's role + id, the members, and the pending invites", async () => {
    const result = await loadTeam();
    expect(result).toEqual({
      status: "ok",
      role: "owner",
      userId: "u_owner",
      members: [MEMBER],
      invites: [INVITE],
    });
    // Both reads are scoped to the caller's org.
    expect(listOrgMembers).toHaveBeenCalledWith(expect.anything(), "org_1");
    expect(listPendingInvites).toHaveBeenCalledWith(expect.anything(), "org_1");
  });

  it("passes the role through unchanged for a plain member (so the UI renders read-only)", async () => {
    requireOrgAccess.mockResolvedValueOnce({
      userId: "u_m",
      orgId: "org_1",
      role: "member",
      user: { name: "M", email: "m@acme.test", image: null },
    });
    expect(await loadTeam()).toMatchObject({ status: "ok", role: "member", userId: "u_m" });
  });

  it("surfaces a read failure as an error result (never throws to the page)", async () => {
    listOrgMembers.mockRejectedValueOnce(new Error("db down"));
    expect(await loadTeam()).toEqual({ status: "error" });
  });
});
