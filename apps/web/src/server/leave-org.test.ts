import { beforeEach, describe, expect, it, vi } from "vitest";

const requireOrgAccess = vi.fn();
vi.mock("./org-access", () => ({ requireOrgAccess: () => requireOrgAccess() }));

const { LastOwnerError } = vi.hoisted(() => ({
  LastOwnerError: class LastOwnerError extends Error {},
}));
const removeMember = vi.fn();
vi.mock("@webhook-co/db/members", () => ({
  removeMember: (...a: unknown[]) => removeMember(...a),
  LastOwnerError,
}));

const listUserOrgs = vi.fn();
vi.mock("@webhook-co/db/orgs", () => ({ listUserOrgs: (...a: unknown[]) => listUserOrgs(...a) }));

const evictRevokedKeyHashes = vi.fn(async () => {});
vi.mock("./credential-revoke", () => ({
  evictRevokedKeyHashes: (...a: unknown[]) => evictRevokedKeyHashes(...a),
}));

const remintSessionForOrg = vi.fn(async () => "ok");
vi.mock("./session-remint", () => ({
  remintSessionForOrg: (...a: unknown[]) => remintSessionForOrg(...a),
}));

vi.mock("@webhook-co/shared/audit", () => ({ importAuditKey: async () => ({}) as CryptoKey }));
vi.mock("@webhook-co/shared/bytes", () => ({ b64ToBytes: () => new Uint8Array(32) }));
vi.mock("./env", () => ({ getAuditChainKey: async () => "AA".repeat(32) }));
vi.mock("./db", () => ({ withTenantDb: (fn: (app: unknown) => unknown) => fn({}) }));
vi.mock("./session", () => ({ LOGOUT_URL: "https://auth.test/logout" }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "acme" }),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

import { leaveOrgAction } from "./leave-org";

const HASH = Buffer.from("aa", "hex");

beforeEach(() => {
  vi.clearAllMocks();
  requireOrgAccess.mockResolvedValue({
    userId: "u_1",
    orgId: "org_team",
    slug: "acme",
    role: "member",
    user: { name: "D", email: "d@acme.test", image: null },
  });
  removeMember.mockResolvedValue({ removed: true, revokedKeyHashes: [HASH] });
  listUserOrgs.mockResolvedValue([
    { orgId: "org_team", slug: "acme", name: "Acme", role: "member" },
    { orgId: "org_personal", slug: "dana", name: "Personal", role: "owner" },
  ]);
  remintSessionForOrg.mockResolvedValue("ok");
});

describe("leaveOrgAction", () => {
  it("removes YOURSELF with the same atomic revocation as a removal, and evicts your keys", async () => {
    await expect(leaveOrgAction("acme")).rejects.toThrow(
      "NEXT_REDIRECT:/org/dana/dashboard?org=left",
    );

    // Leaving IS removing yourself — same code path, so it can't drift from removeMember's guarantees.
    expect(removeMember).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: "org_team",
        userId: "u_1",
        actorId: "u_1",
        actorRole: "member",
      }),
    );
    expect(evictRevokedKeyHashes).toHaveBeenCalledWith([HASH], { kind: "member", id: "u_1" });
  });

  it("moves the session to an org you're still in — otherwise you'd look logged out", async () => {
    await expect(leaveOrgAction("acme")).rejects.toThrow(
      "NEXT_REDIRECT:/org/dana/dashboard?org=left",
    );
    expect(remintSessionForOrg).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u_1" }),
      "org_personal", // NOT the org just left
    );
  });

  it("REFUSES a sole owner — nothing revoked, nothing left, session untouched", async () => {
    // The org would be stranded with no owner. They must promote someone first (the /team role picker), or
    // delete the org. This is the same guard that blocks a sole owner's account deletion.
    removeMember.mockRejectedValueOnce(new LastOwnerError("sole owner"));
    expect(await leaveOrgAction("acme")).toEqual({ status: "last_owner" });
    expect(evictRevokedKeyHashes).not.toHaveBeenCalled();
    expect(remintSessionForOrg).not.toHaveBeenCalled();
  });

  it("signs you out rather than leaving the session pointing at an org you just left", async () => {
    listUserOrgs.mockResolvedValueOnce([
      { orgId: "org_team", slug: "acme", name: "Acme", role: "member" },
    ]);
    await expect(leaveOrgAction("acme")).rejects.toThrow("NEXT_REDIRECT:https://auth.test/logout");
  });

  it("signs you out if the session can't be re-minted — never guesses", async () => {
    remintSessionForOrg.mockResolvedValueOnce("no_session");
    await expect(leaveOrgAction("acme")).rejects.toThrow("NEXT_REDIRECT:https://auth.test/logout");
  });

  it("reports an error without leaving the org half-left", async () => {
    removeMember.mockRejectedValueOnce(new Error("db down"));
    expect(await leaveOrgAction("acme")).toEqual({ status: "error" });
    expect(evictRevokedKeyHashes).not.toHaveBeenCalled();
  });
});
