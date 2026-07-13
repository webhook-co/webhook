import { beforeEach, describe, expect, it, vi } from "vitest";

const requireOrgAccess = vi.fn();
vi.mock("./org-access", () => ({ requireOrgAccess: () => requireOrgAccess() }));

const changeMemberRole = vi.fn();
const removeMember = vi.fn();
// vi.mock factories are hoisted above module scope, so the error classes the action does `instanceof`
// against must be created inside vi.hoisted — a plain top-level class isn't initialized yet when the
// factory runs.
const { MemberCeilingError, LastOwnerError, MemberNotFoundError } = vi.hoisted(() => ({
  MemberCeilingError: class MemberCeilingError extends Error {},
  LastOwnerError: class LastOwnerError extends Error {},
  MemberNotFoundError: class MemberNotFoundError extends Error {},
}));
vi.mock("@webhook-co/db/members", () => ({
  changeMemberRole: (...a: unknown[]) => changeMemberRole(...a),
  removeMember: (...a: unknown[]) => removeMember(...a),
  MemberCeilingError,
  LastOwnerError,
  MemberNotFoundError,
}));

const evictRevokedKeyHashes = vi.fn(async () => {});
vi.mock("./credential-revoke", () => ({
  evictRevokedKeyHashes: (...a: unknown[]) => evictRevokedKeyHashes(...a),
}));

vi.mock("@webhook-co/shared/audit", () => ({ importAuditKey: async () => ({}) as CryptoKey }));
vi.mock("@webhook-co/shared/bytes", () => ({ b64ToBytes: () => new Uint8Array(32) }));
vi.mock("./env", () => ({ getAuditChainKey: async () => "BB".repeat(32) }));
vi.mock("./db", () => ({ withTenantDb: (fn: (app: unknown) => unknown) => fn({}) }));

import { changeMemberRoleAction, removeMemberAction } from "./member-actions";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

const HASH_A = Buffer.from("aa", "hex");
const HASH_B = Buffer.from("bb", "hex");

beforeEach(() => {
  vi.clearAllMocks();
  requireOrgAccess.mockResolvedValue({
    userId: "u_owner",
    orgId: "org_1",
    role: "owner",
    user: { name: "O", email: "o@acme.test", image: null },
  });
  changeMemberRole.mockResolvedValue({ changed: true, revokedKeyHashes: [] });
  removeMember.mockResolvedValue({ removed: true, revokedKeyHashes: [] });
});

describe("changeMemberRoleAction", () => {
  it("passes the SERVER-derived actor role as the ceiling (never the client's)", async () => {
    const res = await changeMemberRoleAction("acme", form({ userId: "u_x", role: "admin" }));
    expect(res).toEqual({ status: "ok" });
    expect(changeMemberRole).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: "org_1",
        userId: "u_x",
        newRole: "admin",
        actorId: "u_owner",
        actorRole: "owner",
      }),
    );
  });

  it("EVICTS every key a demotion revoked from the credential cache", async () => {
    changeMemberRole.mockResolvedValueOnce({ changed: true, revokedKeyHashes: [HASH_A, HASH_B] });
    await changeMemberRoleAction("acme", form({ userId: "u_x", role: "member" }));
    expect(evictRevokedKeyHashes).toHaveBeenCalledWith([HASH_A, HASH_B], {
      kind: "member",
      id: "u_x",
    });
  });

  it("refuses a plain member (not owner/admin)", async () => {
    requireOrgAccess.mockResolvedValueOnce({
      userId: "u_m",
      orgId: "org_1",
      role: "member",
      user: { name: "", email: "", image: null },
    });
    expect(await changeMemberRoleAction("acme", form({ userId: "u_x", role: "admin" }))).toEqual({
      status: "forbidden",
    });
    expect(changeMemberRole).not.toHaveBeenCalled();
  });

  it("rejects an unknown role", async () => {
    expect(
      await changeMemberRoleAction("acme", form({ userId: "u_x", role: "superuser" })),
    ).toMatchObject({
      status: "invalid",
    });
    expect(changeMemberRole).not.toHaveBeenCalled();
  });

  it("maps the ceiling error to forbidden", async () => {
    changeMemberRole.mockRejectedValueOnce(new MemberCeilingError("nope"));
    expect(await changeMemberRoleAction("acme", form({ userId: "u_x", role: "admin" }))).toEqual({
      status: "forbidden",
    });
  });

  it("maps the last-owner guard to its own explanatory status", async () => {
    changeMemberRole.mockRejectedValueOnce(new LastOwnerError("nope"));
    expect(await changeMemberRoleAction("acme", form({ userId: "u_x", role: "member" }))).toEqual({
      status: "last_owner",
    });
  });
});

describe("removeMemberAction", () => {
  it("removes and evicts every revoked key hash", async () => {
    removeMember.mockResolvedValueOnce({ removed: true, revokedKeyHashes: [HASH_A] });
    const res = await removeMemberAction("acme", form({ userId: "u_x" }));
    expect(res).toEqual({ status: "ok" });
    expect(removeMember).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: "org_1",
        userId: "u_x",
        actorId: "u_owner",
        actorRole: "owner",
      }),
    );
    expect(evictRevokedKeyHashes).toHaveBeenCalledWith([HASH_A], { kind: "member", id: "u_x" });
  });

  it("refuses a plain member", async () => {
    requireOrgAccess.mockResolvedValueOnce({
      userId: "u_m",
      orgId: "org_1",
      role: "member",
      user: { name: "", email: "", image: null },
    });
    expect(await removeMemberAction("acme", form({ userId: "u_x" }))).toEqual({
      status: "forbidden",
    });
    expect(removeMember).not.toHaveBeenCalled();
  });

  it("maps the last-owner guard to last_owner", async () => {
    removeMember.mockRejectedValueOnce(new LastOwnerError("nope"));
    expect(await removeMemberAction("acme", form({ userId: "u_x" }))).toEqual({
      status: "last_owner",
    });
  });

  it("does NOT evict when the DB revoke threw (nothing was committed)", async () => {
    removeMember.mockRejectedValueOnce(new Error("db down"));
    expect(await removeMemberAction("acme", form({ userId: "u_x" }))).toEqual({ status: "error" });
    expect(evictRevokedKeyHashes).not.toHaveBeenCalled();
  });
});
