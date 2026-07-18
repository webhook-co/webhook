import { beforeEach, describe, expect, it, vi } from "vitest";

// deleteOrRequestOrg is the seam the DASHBOARD org-delete (deleteOrganization) routes through, so the
// ASYNC_ORG_DELETION flag branch and the KV credential eviction are decided in ONE place. (Account deletion
// does NOT use it — it stays synchronous even under the flag; see account-actions.test.ts.) This file is that
// decision's only guard — the caller mocks deleteOrRequestOrg out entirely.
//
// The invariant with teeth: when async is ON, the reaper leaves the org row alive for its whole drain window,
// so a revoked key must be evicted from KV_AUTHZ or it keeps authenticating against a still-existing org. The
// sync path erases the org in one tx, so there is nothing left to authenticate against and no eviction is owed.

const deleteOrgWithAudit = vi.fn(async () => ({ orgId: "org_1", deletedAt: "now" }));
const requestOrgDeletion = vi.fn(async () => ({
  orgId: "org_1",
  deletingAt: "now",
  revokedKeyHashes: [Buffer.from("aa", "hex"), Buffer.from("bb", "hex")],
}));
vi.mock("@webhook-co/db/org-lifecycle", () => ({
  deleteOrgWithAudit: (...a: unknown[]) => deleteOrgWithAudit(...a),
  requestOrgDeletion: (...a: unknown[]) => requestOrgDeletion(...a),
}));

const evictRevokedKeyHashes = vi.fn(async () => {});
vi.mock("./credential-revoke", () => ({
  evictRevokedKeyHashes: (...a: unknown[]) => evictRevokedKeyHashes(...a),
}));

const getAsyncOrgDeletionEnabled = vi.fn(() => false);
vi.mock("./env", () => ({
  getAsyncOrgDeletionEnabled: () => getAsyncOrgDeletionEnabled(),
}));

import { deleteOrRequestOrg } from "./org-delete";

const app = {} as never;
const auditKey = {} as CryptoKey;
const input = { orgId: "org_1", actor: { kind: "user" as const, id: "usr_1" } };

beforeEach(() => vi.clearAllMocks());

describe("deleteOrRequestOrg", () => {
  it("flag OFF (default): the proven synchronous hard-delete, no async request, no eviction", async () => {
    getAsyncOrgDeletionEnabled.mockReturnValueOnce(false);

    await deleteOrRequestOrg(app, input, auditKey);

    expect(deleteOrgWithAudit).toHaveBeenCalledOnce();
    expect(deleteOrgWithAudit).toHaveBeenCalledWith(app, input, auditKey);
    // The async marker + the reaper are dark; the KV eviction only applies to the async path.
    expect(requestOrgDeletion).not.toHaveBeenCalled();
    expect(evictRevokedKeyHashes).not.toHaveBeenCalled();
  });

  it("flag ON: marks the org deleting and EVICTS the revoked key hashes it returns from KV_AUTHZ", async () => {
    getAsyncOrgDeletionEnabled.mockReturnValueOnce(true);

    await deleteOrRequestOrg(app, input, auditKey);

    expect(requestOrgDeletion).toHaveBeenCalledOnce();
    expect(requestOrgDeletion).toHaveBeenCalledWith(app, input, auditKey);
    // The synchronous cascade must NOT also run — that would erase the rows the reaper is meant to drain.
    expect(deleteOrgWithAudit).not.toHaveBeenCalled();
    // The eviction carries the EXACT hashes requestOrgDeletion revoked, scoped to this org. Without it a
    // revoked key keeps authenticating against the still-alive org for the credential-cache TTL.
    expect(evictRevokedKeyHashes).toHaveBeenCalledOnce();
    expect(evictRevokedKeyHashes).toHaveBeenCalledWith(
      [Buffer.from("aa", "hex"), Buffer.from("bb", "hex")],
      { kind: "org", id: "org_1" },
    );
  });
});
