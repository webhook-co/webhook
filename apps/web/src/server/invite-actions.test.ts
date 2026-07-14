import { beforeEach, describe, expect, it, vi } from "vitest";

const requireOrgAccess = vi.fn(async () => ({
  userId: "u_owner",
  orgId: "org_1",
  slug: "acme",
  role: "owner" as string,
  user: { name: "O", email: "o@acme.test", image: null },
}));
vi.mock("./org-access", () => ({ requireOrgAccess: () => requireOrgAccess() }));

const verifySession = vi.fn(async () => ({
  userId: "u_acc",
  orgId: "org_x",
  user: { name: "A", email: "bob@acme.test", image: null },
}));
vi.mock("./session", () => ({
  verifySession: () => verifySession(),
  LOGOUT_URL: "https://auth.test/logout",
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "acme" }),
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
const listUserOrgs = vi.fn(async () => [
  { orgId: "org_x", slug: "acme", name: "Acme", role: "member", formerSlugs: [] },
]);
vi.mock("@webhook-co/db/orgs", () => ({ listUserOrgs: (...a: unknown[]) => listUserOrgs(...a) }));
vi.mock("@webhook-co/db/credential", () => ({ createCredentialHasherFromBase64: () => ({}) }));
vi.mock("@webhook-co/shared/audit", () => ({ importAuditKey: async () => ({}) as CryptoKey }));
vi.mock("@webhook-co/shared/bytes", () => ({ b64ToBytes: () => new Uint8Array(32) }));
// vi.mock factories are hoisted above module scope, so anything they close over must come from vi.hoisted.
const { resendKey, sendInviteEmail } = vi.hoisted(() => ({
  resendKey: vi.fn((): string | null => "re_key"),
  sendInviteEmail: vi.fn(async () => {}),
}));
vi.mock("./env", () => ({
  getCredentialPepper: async () => "AA".repeat(16),
  getAuditChainKey: async () => "BB".repeat(32),
  getResendApiKey: async () => resendKey(),
  getAppBaseUrl: () => "https://app.webhook.co",
}));
vi.mock("./invite-email", () => ({
  sendInviteEmail: (...a: unknown[]) => sendInviteEmail(...a),
}));
// withTenantDb(fn) → fn(app); the db invite fns are mocked, so app is a stub.
vi.mock("./db", () => ({ withTenantDb: (fn: (app: unknown) => unknown) => fn({}) }));
const readInviteCookie = vi.fn(async (): Promise<{ org: string; token: string } | null> => null);
const clearInviteCookie = vi.fn(async () => {});
vi.mock("./invite-cookie", () => ({
  readInviteCookie: () => readInviteCookie(),
  clearInviteCookie: () => clearInviteCookie(),
}));

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
    slug: "acme",
    role: "owner",
    user: { name: "O", email: "o@acme.test", image: null },
  });
  listUserOrgs.mockResolvedValue([
    { orgId: "org_x", slug: "acme", name: "Acme", role: "member", formerSlugs: [] },
  ]);
  createInvite.mockResolvedValue({
    id: "inv_1",
    token: "whinv_secret",
    invitedEmail: "bob@acme.test",
    role: "member",
  });
});

describe("createInviteAction", () => {
  it("owner invites a member → ok, returns the accept link with org + token", async () => {
    const res = await createInviteAction("acme", form({ email: "bob@acme.test", role: "member" }));
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
    expect(
      await createInviteAction("acme", form({ email: "x@acme.test", role: "member" })),
    ).toEqual({
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
    expect(await createInviteAction("acme", form({ email: "x@acme.test", role: "owner" }))).toEqual(
      {
        status: "forbidden",
      },
    );
    expect(createInvite).not.toHaveBeenCalled();
  });

  it("EMAILS the invite link and reports emailed:true", async () => {
    const res = await createInviteAction("acme", form({ email: "bob@acme.test", role: "member" }));
    expect(res).toMatchObject({ status: "ok", emailed: true });
    expect(sendInviteEmail).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "re_key" }),
      expect.objectContaining({
        to: "bob@acme.test",
        url: "https://app.webhook.co/invite/accept?org=org_1&token=whinv_secret",
        invitedBy: "o@acme.test", // the INVITER's own authenticated email
      }),
    );
  });

  it("still succeeds (emailed:false) when mail isn't configured — the invite is not lost", async () => {
    resendKey.mockReturnValueOnce(null);
    const res = await createInviteAction("acme", form({ email: "bob@acme.test", role: "member" }));
    expect(res).toMatchObject({ status: "ok", emailed: false });
    expect(sendInviteEmail).not.toHaveBeenCalled();
  });

  it("still succeeds (emailed:false) when the SEND FAILS — never lose a committed invite to a mail outage", async () => {
    sendInviteEmail.mockRejectedValueOnce(new Error("resend 500"));
    const res = await createInviteAction("acme", form({ email: "bob@acme.test", role: "member" }));
    expect(res).toMatchObject({ status: "ok", emailed: false });
    if (res.status === "ok") expect(res.acceptPath).toContain("token=whinv_secret");
  });

  it("rejects a malformed email/role", async () => {
    expect(
      await createInviteAction("acme", form({ email: "not-an-email", role: "member" })),
    ).toMatchObject({ status: "invalid" });
    expect(
      await createInviteAction("acme", form({ email: "x@acme.test", role: "superuser" })),
    ).toMatchObject({ status: "invalid" });
  });
});

describe("revokeInviteAction", () => {
  it("owner revokes → ok", async () => {
    expect(await revokeInviteAction("acme", form({ inviteId: "inv_1" }))).toEqual({ status: "ok" });
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
    expect(await revokeInviteAction("acme", form({ inviteId: "inv_1" }))).toEqual({
      status: "forbidden",
    });
    expect(revokeInvite).not.toHaveBeenCalled();
  });
});

describe("acceptInviteAction", () => {
  it("accepts against the SESSION's email and lands on ?invite=accepted", async () => {
    acceptInvite.mockResolvedValueOnce({ status: "accepted", role: "member" });
    await expect(acceptInviteAction(form({ org: "org_x", token: "whinv_t" }))).rejects.toThrow(
      "NEXT_REDIRECT:/org/acme/dashboard?invite=accepted",
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
      "NEXT_REDIRECT:/org/acme/dashboard?invite=invalid",
    );
  });

  it("lands on ?invite=invalid when org/token are missing (no accept attempt)", async () => {
    await expect(acceptInviteAction(form({}))).rejects.toThrow(
      "NEXT_REDIRECT:/org/acme/dashboard?invite=invalid",
    );
    expect(acceptInvite).not.toHaveBeenCalled();
  });

  it("reads the token from the invite cookie when the form has none (returned new invitee)", async () => {
    readInviteCookie.mockResolvedValueOnce({ org: "org_x", token: "whinv_cookie" });
    acceptInvite.mockResolvedValueOnce({ status: "accepted", role: "member" });
    await expect(acceptInviteAction(form({ org: "org_x" }))).rejects.toThrow(
      "NEXT_REDIRECT:/org/acme/dashboard?invite=accepted",
    );
    expect(acceptInvite).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ orgId: "org_x", token: "whinv_cookie" }),
    );
  });

  it("prefers the FORM token over the cookie (never reads the cookie when the URL has it)", async () => {
    acceptInvite.mockResolvedValueOnce({ status: "accepted", role: "member" });
    await expect(acceptInviteAction(form({ org: "org_x", token: "whinv_url" }))).rejects.toThrow(
      "NEXT_REDIRECT:/org/acme/dashboard?invite=accepted",
    );
    expect(readInviteCookie).not.toHaveBeenCalled();
    expect(acceptInvite.mock.calls[0]![2]).toMatchObject({ token: "whinv_url" });
  });

  it("ignores a cookie token whose org does not match this accept", async () => {
    readInviteCookie.mockResolvedValueOnce({ org: "org_other", token: "whinv_cookie" });
    await expect(acceptInviteAction(form({ org: "org_x" }))).rejects.toThrow(
      "NEXT_REDIRECT:/org/acme/dashboard?invite=invalid",
    );
    expect(acceptInvite).not.toHaveBeenCalled(); // no usable token → no attempt
  });

  it("clears the invite cookie it consumed on a terminal outcome (accepted)", async () => {
    readInviteCookie.mockResolvedValueOnce({ org: "org_x", token: "whinv_cookie" });
    acceptInvite.mockResolvedValueOnce({ status: "accepted", role: "member" });
    await expect(acceptInviteAction(form({ org: "org_x" }))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(clearInviteCookie).toHaveBeenCalledOnce();
  });

  it("KEEPS the cookie on a transient error — it's the invitee's only token copy (retry stays possible)", async () => {
    readInviteCookie.mockResolvedValueOnce({ org: "org_x", token: "whinv_cookie" });
    acceptInvite.mockRejectedValueOnce(new Error("db blip")); // → outcome "error"
    await expect(acceptInviteAction(form({ org: "org_x" }))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(clearInviteCookie).not.toHaveBeenCalled();
  });

  it("does NOT clear the cookie when the token came from the FORM (may hold an unrelated org's invite)", async () => {
    // Accepting org_x via a URL token must not wipe a cookie stashed for a DIFFERENT org.
    acceptInvite.mockResolvedValueOnce({ status: "accepted", role: "member" });
    await expect(acceptInviteAction(form({ org: "org_x", token: "whinv_url" }))).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
    expect(clearInviteCookie).not.toHaveBeenCalled();
  });

  // 🔑 A SUCCESSFUL accept must never sign the user out.
  //
  // Building the landing URL needs the joined org's slug, which is a second directory read — and that read can
  // throw transiently while the accept has ALREADY committed. The first cut fell back to LOGOUT_URL, so a flaky
  // read bounced a user who just joined an org to sign-in. It must degrade to `/` (which re-resolves and keeps
  // the banner), NOT logout.
  it("accepted + the directory read THROWS → `/`, never logout", async () => {
    acceptInvite.mockResolvedValueOnce({ status: "accepted", role: "member" });
    listUserOrgs.mockRejectedValueOnce(new Error("hyperdrive blip"));

    await expect(acceptInviteAction(form({ org: "org_x", token: "whinv_t" }))).rejects.toThrow(
      "NEXT_REDIRECT:/?invite=accepted",
    );
  });

  it("accepted + the joined org is somehow absent from the list → `/`, never logout", async () => {
    acceptInvite.mockResolvedValueOnce({ status: "accepted", role: "member" });
    listUserOrgs.mockResolvedValueOnce([]); // read succeeded but returned nothing

    await expect(acceptInviteAction(form({ org: "org_x", token: "whinv_t" }))).rejects.toThrow(
      "NEXT_REDIRECT:/?invite=accepted",
    );
  });

  it("INVALID + no org to fall back to → logout (the pre-existing dead end, unchanged)", async () => {
    acceptInvite.mockResolvedValueOnce({ status: "invalid" });
    listUserOrgs.mockResolvedValueOnce([]);

    await expect(acceptInviteAction(form({ org: "org_x", token: "nope" }))).rejects.toThrow(
      "NEXT_REDIRECT:https://auth.test/logout",
    );
  });

  it("INVALID + a fallback org present → its dashboard with ?invite=invalid, NOT logout", async () => {
    acceptInvite.mockResolvedValueOnce({ status: "invalid" });
    // session's own org is org_x/acme (see the session mock), and it is in the directory → land there.

    await expect(acceptInviteAction(form({ org: "org_x", token: "nope" }))).rejects.toThrow(
      "NEXT_REDIRECT:/org/acme/dashboard?invite=invalid",
    );
  });
});
