"use server";

import {
  changeMemberRole,
  LastOwnerError,
  MemberCeilingError,
  MemberNotFoundError,
  removeMember,
} from "@webhook-co/db/members";
import { MembershipRoleSchema } from "@webhook-co/shared";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";

import { logActionError } from "./action-log";
import { evictRevokedKeyHashes } from "./credential-revoke";
import { withTenantDb } from "./db";
import { getAuditChainKey } from "./env";
import { requireOrgAccess } from "./org-access";

// Member management server actions (Lane 2.6). Both gate on requireOrgAccess (owner/admin only) and pass the
// SERVER-derived actor role as the ceiling — a client cannot claim to be an owner. The DB layer enforces the
// rest of the authz (you cannot act on someone who outranks you; the last owner is untouchable) and revokes
// the member's grants + keys IN THE SAME TRANSACTION as the membership change.
//
// The second half of that revoke lives here: the DB hands back the revoked key hashes and we EVICT each from
// the shared KV credential cache. Without the eviction a removed member's key keeps authenticating for the
// cache TTL. Ordering is load-bearing (the Lane S lesson): DB commit FIRST, then evict — evicting a
// not-yet-committed revoke would re-populate the cache from the still-live row.

/** Only owner/admin manage members; a plain member is operational-only. */
function canManageMembers(role: string): boolean {
  return role === "owner" || role === "admin";
}

export type MemberActionResult = {
  readonly status: "ok" | "forbidden" | "invalid" | "last_owner" | "not_found" | "error";
};

async function auditKey(): Promise<CryptoKey> {
  return importAuditKey(b64ToBytes(await getAuditChainKey()));
}

/** Map the DB layer's typed refusals onto the action's result vocabulary. */
function mapError(error: unknown, op: string): MemberActionResult {
  if (error instanceof LastOwnerError) return { status: "last_owner" };
  if (error instanceof MemberCeilingError) return { status: "forbidden" };
  if (error instanceof MemberNotFoundError) return { status: "not_found" };
  logActionError(op, error); // only a genuine fault is logged — a refusal is expected, not an incident
  return { status: "error" };
}

/**
 * Change a member's role. Owner/admin only. A demotion revokes the keys they minted under the higher role
 * (in the DB tx); those hashes are then evicted from the credential cache so they die immediately.
 */
export async function changeMemberRoleAction(formData: FormData): Promise<MemberActionResult> {
  const { orgId, userId: actorId, role } = await requireOrgAccess();
  if (!canManageMembers(role)) return { status: "forbidden" };

  const targetId = String(formData.get("userId") ?? "");
  const roleParse = MembershipRoleSchema.safeParse(formData.get("role"));
  if (!targetId || !roleParse.success) return { status: "invalid" };

  try {
    const result = await withTenantDb(async (app) =>
      changeMemberRole(app, {
        orgId,
        userId: targetId,
        newRole: roleParse.data,
        actorId,
        actorRole: role, // server-derived — the ceiling the client cannot lift
        auditKey: await auditKey(),
      }),
    );
    // Only reached once the DB tx COMMITTED, so every hash here is durably revoked.
    await evictRevokedKeyHashes(result.revokedKeyHashes, { kind: "member", id: targetId });
    return { status: "ok" };
  } catch (error) {
    return mapError(error, "member.role_change_failed");
  }
}

/**
 * Remove a member from the org. Owner/admin only. The membership delete and the revocation of their grants +
 * every key they hold are one transaction; the revoked hashes are evicted from the credential cache here.
 */
export async function removeMemberAction(formData: FormData): Promise<MemberActionResult> {
  const { orgId, userId: actorId, role } = await requireOrgAccess();
  if (!canManageMembers(role)) return { status: "forbidden" };

  const targetId = String(formData.get("userId") ?? "");
  if (!targetId) return { status: "invalid" };

  try {
    const result = await withTenantDb(async (app) =>
      removeMember(app, {
        orgId,
        userId: targetId,
        actorId,
        actorRole: role, // server-derived
        auditKey: await auditKey(),
      }),
    );
    await evictRevokedKeyHashes(result.revokedKeyHashes, { kind: "member", id: targetId });
    return { status: "ok" };
  } catch (error) {
    return mapError(error, "member.remove_failed");
  }
}
