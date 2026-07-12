import { canGrantRole, roleRank, type MembershipRole } from "@webhook-co/shared";

import { appendAuthAuditEntry } from "./auth-audit";
import { withTenant, type Sql, type TenantTx } from "./client";

// Member management (Lane 2.6): list, change role, remove. The security core is **atomic revocation** — a
// membership change and the death of the credentials it authorized happen in ONE transaction, so there is
// no window in which a demoted/removed principal still holds usable keys.
//
// The rule behind both mutations: **a credential minted under an authority the user no longer holds must
// die.** Scopes are frozen into a key at mint time (the S.5 mint ceiling), so nothing narrows them
// retroactively — the key itself has to go. That means:
//   - REMOVE  → revoke their grants, the keys minted under those grants, and every key they created
//              (including org-owned service keys: they may still hold the plaintext).
//   - DEMOTE  → revoke the same set (those keys may carry scopes above the new role).
//   - PROMOTE → revoke nothing (a wider authority invalidates no existing credential).
// The caller must EVICT the returned key hashes from the shared KV credential cache — the DB revoke is
// durable, but the cache would otherwise keep authenticating them for its TTL (see credential-revoke.ts).
//
// AUTHZ is enforced here, not left to the caller: you cannot act on someone who outranks you, you cannot
// grant a role above your own, and the LAST OWNER can never be demoted or removed (a zero-owner org is
// RLS-unreachable forever, still billed, and its alerts go nowhere — see org-lifecycle.ts).
//
// LIMITATION (documented, not silently accepted): keys minted BEFORE migration 0057 carry a null
// `created_by`, so a removal cannot attribute them to the leaver. Grant-derived keys are still caught (via
// grant_id), but a pre-0057 standalone key is not. Prod is young enough that this set is empty-to-tiny;
// revisit if it ever isn't.

/** Thrown when the actor may not act on this target, or may not grant the requested role. */
export class MemberCeilingError extends Error {
  constructor(
    readonly actorRole: string,
    readonly detail: string,
  ) {
    super(`role '${actorRole}' cannot ${detail}`);
    this.name = "MemberCeilingError";
  }
}

/** Thrown when the mutation would leave the org with no owner. */
export class LastOwnerError extends Error {
  constructor() {
    super("the last owner cannot be demoted or removed — transfer ownership first");
    this.name = "LastOwnerError";
  }
}

/** Thrown when the target is not a member of the org. */
export class MemberNotFoundError extends Error {
  constructor(readonly userId: string) {
    super(`user is not a member of this org`);
    this.name = "MemberNotFoundError";
  }
}

export interface OrgMember {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: MembershipRole;
  readonly joinedAt: string;
}

/**
 * List an org's members with their identity + role, oldest first. Runs under the org's RLS context with an
 * EXPLICIT org_id predicate (RLS policies are permissive/OR'd — never lean on RLS alone for a scoped read).
 */
export async function listOrgMembers(app: Sql, orgId: string): Promise<OrgMember[]> {
  const rows = await withTenant(
    app,
    orgId,
    (tx) =>
      tx<
        { user_id: string; name: string; email: string; role: MembershipRole; created_at: Date }[]
      >`
        select m.user_id, u.name, u.email, m.role, m.created_at
          from memberships m
          join "user" u on u.id = m.user_id
         where m.org_id = ${orgId}
         order by m.created_at asc`,
  );
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    email: r.email,
    role: r.role,
    joinedAt: r.created_at.toISOString(),
  }));
}

/** The org's owner count + the target's current role, read inside the mutation's own tx. */
async function readTargetAndCensus(
  tx: TenantTx,
  orgId: string,
  userId: string,
): Promise<{ role: MembershipRole; owners: number }> {
  const [target] = await tx<{ role: MembershipRole }[]>`
    select role from memberships where org_id = ${orgId} and user_id = ${userId}`;
  if (!target) throw new MemberNotFoundError(userId);
  const [census] = await tx<{ owners: string }[]>`
    select count(*) filter (where role = 'owner') as owners
      from memberships where org_id = ${orgId}`;
  return { role: target.role, owners: Number(census?.owners ?? 0) };
}

/**
 * Revoke, in the caller's tx, every credential the user holds in this org: the keys minted under their
 * grants (caught by grant_id, so a null created_by doesn't hide them) and every key they created
 * (including org-owned service keys — they may still know the plaintext). Returns the revoked hashes.
 * The grants themselves are revoked separately (only on removal — a demotion leaves the grant, whose
 * next refresh NARROWS its scopes to the new role).
 */
async function revokeUserKeysInTx(tx: TenantTx, orgId: string, userId: string): Promise<Buffer[]> {
  const rows = await tx<{ key_hash: Buffer }[]>`
    update api_keys
       set revoked_at = now(), updated_at = now()
     where org_id = ${orgId}
       and revoked_at is null
       and (
         created_by = ${userId}
         or grant_id in (select id from auth_grant where org_id = ${orgId} and user_id = ${userId})
       )
    returning key_hash`;
  return rows.map((r) => Buffer.from(r.key_hash));
}

export interface ChangeMemberRoleInput {
  readonly orgId: string;
  /** The member whose role changes. */
  readonly userId: string;
  readonly newRole: MembershipRole;
  /** The acting user (audit actor + the ceiling). MUST be server-derived, never client input. */
  readonly actorId: string;
  readonly actorRole: MembershipRole;
  readonly auditKey: CryptoKey;
  readonly now?: number;
}

export interface ChangeMemberRoleResult {
  /** False when the role was already `newRole` (a no-op: nothing revoked, nothing audited). */
  readonly changed: boolean;
  /** Hashes of keys revoked by a demotion — the caller MUST evict each from the credential cache. */
  readonly revokedKeyHashes: readonly Buffer[];
}

/**
 * Change a member's role. Refuses if the actor may not grant `newRole`, may not act on the target's current
 * role, or if this would demote the last owner. A DEMOTION revokes the member's keys in the same tx (they
 * were minted under an authority the member no longer holds); a promotion revokes nothing.
 */
export async function changeMemberRole(
  app: Sql,
  input: ChangeMemberRoleInput,
): Promise<ChangeMemberRoleResult> {
  // You can never hand out more than you hold.
  if (!canGrantRole(input.actorRole, input.newRole)) {
    throw new MemberCeilingError(input.actorRole, `grant the role '${input.newRole}'`);
  }
  return withTenant(app, input.orgId, async (tx) => {
    const { role: currentRole, owners } = await readTargetAndCensus(tx, input.orgId, input.userId);

    // You can never act on someone who outranks you (an admin cannot touch an owner).
    if (!canGrantRole(input.actorRole, currentRole)) {
      throw new MemberCeilingError(input.actorRole, `act on a '${currentRole}'`);
    }
    if (currentRole === input.newRole) {
      return { changed: false, revokedKeyHashes: [] }; // no-op: don't revoke, don't audit
    }
    // Demoting the sole owner leaves a zero-owner org — unreachable forever.
    if (currentRole === "owner" && input.newRole !== "owner" && owners === 1) {
      throw new LastOwnerError();
    }

    await tx`
      update memberships set role = ${input.newRole}
       where org_id = ${input.orgId} and user_id = ${input.userId}`;

    // A HIGHER rank number = LESS privilege, so a demotion is rank(new) > rank(old).
    const demoted = roleRank(input.newRole) > roleRank(currentRole);
    const revokedKeyHashes = demoted ? await revokeUserKeysInTx(tx, input.orgId, input.userId) : [];

    await appendAuthAuditEntry(tx, input.auditKey, {
      orgId: input.orgId,
      actor: input.actorId,
      eventType: "member_role_changed",
      targetId: input.userId,
      metadata: {
        from: currentRole,
        to: input.newRole,
        revokedKeyCount: revokedKeyHashes.length,
      },
    });
    return { changed: true, revokedKeyHashes };
  });
}

export interface RemoveMemberInput {
  readonly orgId: string;
  readonly userId: string;
  /** The acting user (audit actor + the ceiling). MUST be server-derived, never client input. */
  readonly actorId: string;
  readonly actorRole: MembershipRole;
  readonly auditKey: CryptoKey;
  readonly now?: number;
}

export interface RemoveMemberResult {
  readonly removed: boolean;
  /** Hashes of every revoked key — the caller MUST evict each from the credential cache. */
  readonly revokedKeyHashes: readonly Buffer[];
}

/**
 * Remove a member from the org: delete the membership AND revoke their grants + every key they hold, all in
 * one transaction — there is no window where a removed member still authenticates. Refuses if the actor may
 * not act on the target, or if this would remove the last owner. Their web access dies on the next request
 * (requireOrgAccess re-reads membership), their refresh tokens die at next use (the issuer re-checks
 * membership), and their keys die here.
 */
export async function removeMember(
  app: Sql,
  input: RemoveMemberInput,
): Promise<RemoveMemberResult> {
  return withTenant(app, input.orgId, async (tx) => {
    const { role: currentRole, owners } = await readTargetAndCensus(tx, input.orgId, input.userId);

    if (!canGrantRole(input.actorRole, currentRole)) {
      throw new MemberCeilingError(input.actorRole, `remove a '${currentRole}'`);
    }
    // Removing the sole owner leaves a zero-owner org — unreachable forever (delete the org instead).
    if (currentRole === "owner" && owners === 1) {
      throw new LastOwnerError();
    }

    // Revoke the keys BEFORE the grants: the key sweep selects grants by user_id (not status), so the order
    // is immaterial for correctness — but doing keys first keeps the returned hash set complete even if a
    // future edit narrows the grant update.
    const revokedKeyHashes = await revokeUserKeysInTx(tx, input.orgId, input.userId);
    const grantRows = await tx<{ id: string }[]>`
      update auth_grant
         set status = 'revoked', revoked_by = ${input.actorId}, revoked_at = now(),
             revocation_reason = 'member_removed'
       where org_id = ${input.orgId} and user_id = ${input.userId} and status <> 'revoked'
      returning id`;

    await tx`
      delete from memberships where org_id = ${input.orgId} and user_id = ${input.userId}`;

    await appendAuthAuditEntry(tx, input.auditKey, {
      orgId: input.orgId,
      actor: input.actorId,
      eventType: "member_removed",
      targetId: input.userId,
      metadata: {
        role: currentRole,
        revokedKeyCount: revokedKeyHashes.length,
        revokedGrantCount: grantRows.length,
      },
    });
    return { removed: true, revokedKeyHashes };
  });
}
