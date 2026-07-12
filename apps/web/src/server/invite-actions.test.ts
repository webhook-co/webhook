import { beforeEach, describe, expect, it, vi } from "vitest";

const requireOrgAccess = vi.fn(async () => ({
  userId: "u_owner",
  orgId: "org_1",
  role: "owner" as string,
  user: { name: "O", email: "o@acme.test", image: null },
}));
vi.mock("./org-access", () => ({ requireOrgAccess: () => requireOrgAccess() }));

const verifySession = vi.fn(async () => ({
  userId: "u_acc",
  orgId: "org_x",
  user: { name: "A", email: "bob@acme.test", image: null },
}));
vi.mock("./session", () => ({ verifySession: () => verifySession() }));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

const createInvite = vi.fn();
const revokeInvite = vi.fn(async () => true);
const acceptInvite = vi.fn();
vi.mock("@webhook-co/db/invites", () => ({
  createInvite: (...a: unknown[]) => createInvite(...a),
  revokeInvite: (...a: unknown[]) => revokeInvite(...a),
  acceptInvite: (...a: unknown[]) => acceptInvite(...a),
}));
vi.mock("@webhook-co/db/credential", () => ({ createCredentialHasherFromBase64: () => ({}) }));
vi.mock("@webhook-co/shared/audit", () => ({ importAuditKey: async () => ({}) as CryptoKey }));
vi.mock("@webhook-co/shared/bytes", () => ({ b64ToBytes: () => new Uint8Array(32) }));
vi.mock("./env", () => ({
  getCredentialPepper: async () => "AA".repeat(16),
  getAuditChainKey: async () => "BB".repeat(32),
}));
// withTenantDb(fn) → fn(app); the db invite fns are mocked, so app is a stub.
vi.mock("./db", () => ({ withTenantDb: (fn: (app: unknown) => unknown) => fn({}) }));

import { acceptInviteAction, createInviteAction, revokeInviteAction } from "./invite-actions";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOrgAccess.mockResolvedValue({
    userId: "u_owner",
    orgId: "org_1",
    role: "owner",
    user: { name: "O", email: "o@acme.test", image: null },
  });
  createInvite.mockResolvedValue({
    id: "inv_1",
    token: "whinv_secret",
    invitedEmail: "bob@acme.test",
    role: "member",
  });
});

describe("createInviteAction", () => {
  it("owner invites a member → ok, returns the accept link with org + token", async () => {
    const res = await createInviteAction(form({ email: "bob@acme.test", role: "member" }));
    expect(res).toMatchObject({ status: "ok", invitedEmail: "bob@acme.test", role: "member" });
    if (res.status === "ok") {
      expect(res.acceptPath).toContain("org=org_1");
      expect(res.acceptPath).toContain("token=whinv_secret");
    }
    // The inviter's own (server-derived) role is passed as the ceiling.
    expect(createInvite).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ inviterRole: "owner", invitedBy: "u_owner", orgId: "org_1" }),
    );
  });

  it("refuses a plain member (not owner/admin)", async () => {
    requireOrgAccess.mockResolvedValueOnce({
      userId: "u_m",
      orgId: "org_1",
      role: "member",
      user: { name: "", email: "", image: null },
    });
    expect(await createInviteAction(form({ email: "x@acme.test", role: "member" }))).toEqual({
      status: "forbidden",
    });
    expect(createInvite).not.toHaveBeenCalled();
  });

  it("refuses inviting above the inviter's role (an admin can't invite an owner)", async () => {
    requireOrgAccess.mockResolvedValueOnce({
      userId: "u_a",
      orgId: "org_1",
      role: "admin",
      user: { name: "", email: "", image: null },
    });
    expect(await createInviteAction(form({ email: "x@acme.test", role: "owner" }))).toEqual({
      status: "forbidden",
    });
    expect(createInvite).not.toHaveBeenCalled();
  });

  it("rejects a malformed email/role", async () => {
    expect(await createInviteAction(form({ email: "not-an-email", role: "member" }))).toMatchObject(
      { status: "invalid" },
    );
    expect(
      await createInviteAction(form({ email: "x@acme.test", role: "superuser" })),
    ).toMatchObject({ status: "invalid" });
  });
});

describe("revokeInviteAction", () => {
  it("owner revokes → ok", async () => {
    expect(await revokeInviteAction(form({ inviteId: "inv_1" }))).toEqual({ status: "ok" });
    expect(revokeInvite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: "org_1", inviteId: "inv_1", revokedBy: "u_owner" }),
    );
  });

  it("refuses a plain member", async () => {
    requireOrgAccess.mockResolvedValueOnce({
      userId: "u_m",
      orgId: "org_1",
      role: "member",
      user: { name: "", email: "", image: null },
    });
    expect(await revokeInviteAction(form({ inviteId: "inv_1" }))).toEqual({ status: "forbidden" });
    expect(revokeInvite).not.toHaveBeenCalled();
  });
});

describe("acceptInviteAction", () => {
  it("accepts against the SESSION's email and lands on ?invite=accepted", async () => {
    acceptInvite.mockResolvedValueOnce({ status: "accepted", role: "member" });
    await expect(acceptInviteAction(form({ org: "org_x", token: "whinv_t" }))).rejects.toThrow(
      "NEXT_REDIRECT:/dashboard?invite=accepted",
    );
    expect(acceptInvite).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        orgId: "org_x",
        token: "whinv_t",
        userId: "u_acc",
        userEmail: "bob@acme.test",
      }),
    );
  });

  it("lands on ?invite=invalid for a bad token", async () => {
    acceptInvite.mockResolvedValueOnce({ status: "invalid" });
    await expect(acceptInviteAction(form({ org: "org_x", token: "nope" }))).rejects.toThrow(
      "NEXT_REDIRECT:/dashboard?invite=invalid",
    );
  });

  it("lands on ?invite=invalid when org/token are missing (no accept attempt)", async () => {
    await expect(acceptInviteAction(form({}))).rejects.toThrow(
      "NEXT_REDIRECT:/dashboard?invite=invalid",
    );
    expect(acceptInvite).not.toHaveBeenCalled();
  });
});
