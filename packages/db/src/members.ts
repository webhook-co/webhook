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
// UNATTRIBUTABLE KEYS — the one gap, and it is SURFACED rather than silently claimed away. A standalone key
// (no grant) whose `created_by` is NULL cannot be tied to the leaver, so a removal cannot know to revoke it.
// Two things produce such keys: (a) keys minted before migration 0057 added `created_by`, and (b) keys whose
// creator later deleted their account — `created_by` is `ON DELETE SET NULL`, so attribution is destroyed by
// design. (b) means this can never be fixed by a NOT NULL constraint or a backfill; the set is not purely
// historical. So removeMember COUNTS these and returns the count: it lands in the audit metadata and the
// caller surfaces it, turning "we revoked everything" into an honest "N org keys can't be attributed to
// anyone — review them in /credentials". Never claim an atomicity you don't have.

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
        { user_id: string; name: string; email: string; role: MembershipRole; joined_at: Date }[]
      >`select user_id, name, email, role, joined_at from org_member_directory()`,
  );
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    email: r.email,
    role: r.role,
    joinedAt: r.joined_at.toISOString(),
  }));
}

/**
 * Serializes member mutations per org. WITHOUT this the last-owner guard is a TOCTOU: the census counts
 * owners, but each mutation only touches the TARGET's row, so two transactions removing two DIFFERENT
 * owners never contend on a row lock. Under READ COMMITTED (what `withTenant`'s `sql.begin()` gives) both
 * read owners=2, both pass the `owners === 1` check, and both commit — leaving a ZERO-OWNER org, which no
 * admin can repair (canGrantRole('admin','owner') is false) and which is exactly the permanent lockout the
 * guard exists to prevent. A regression test runs the two removals concurrently.
 *
 * Taken FIRST in every member mutation, before the census, so the decision and the write are one atomic
 * unit. It is a DIFFERENT namespace from the auth-audit chain lock (which appendAuthAuditEntry takes later
 * in the same tx); the order is always member-lock → audit-lock, and no other writer takes them in the
 * reverse order, so there is no deadlock cycle.
 */
const MEMBER_LOCK_NAMESPACE = 0x4d454d31; // "MEM1"

async function lockOrgMembers(tx: TenantTx, orgId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${orgId}, ${MEMBER_LOCK_NAMESPACE}))`;
}

/**
 * The org's owner count + the target's current role, read inside the mutation's own tx — AFTER
 * {@link lockOrgMembers}, so the census cannot go stale between the check and the write.
 */
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
 * Take the row locks on the user's grants — the ONE thing that serializes us against a concurrent refresh.
 *
 * `mintKeyForGrant` does `select ... from auth_grant where id = $1 FOR UPDATE` before inserting a key, and
 * refuses if it then sees a non-active grant. That row lock IS the protocol: a revoker must contend on the
 * grant row, or a refresh in flight can commit a brand-new key AFTER our api_keys sweep has taken its
 * snapshot — and the cold auth lookup authenticates on `revoked_at is null` ALONE (it checks neither grant
 * status nor membership), so that key would stay live forever for a user we just removed.
 *
 * removeMember gets these locks implicitly by UPDATE-ing auth_grant first. A DEMOTION does not revoke the
 * grant (its next refresh legitimately re-mints, narrowed to the new role), so it must take the locks
 * EXPLICITLY — otherwise a refresh that read the pre-demotion role commits a key carrying the old, higher
 * scopes and escapes the sweep entirely.
 */
async function lockUserGrants(tx: TenantTx, orgId: string, userId: string): Promise<void> {
  await tx`
    select id from auth_grant
     where org_id = ${orgId} and user_id = ${userId}
     for update`;
}

/**
 * Revoke, in the caller's tx, every credential the user holds in this org: the keys minted under their
 * grants (caught by grant_id, so a null created_by doesn't hide them) and every key they created
 * (including org-owned service keys — they may still know the plaintext). Returns the revoked hashes.
 *
 * MUST run AFTER the user's grants are locked/revoked (see lockUserGrants) — otherwise a concurrent refresh
 * slips a fresh key in behind this sweep's snapshot.
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
    await lockOrgMembers(tx, input.orgId); // before the census — the guard must not be a TOCTOU
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
    let revokedKeyHashes: Buffer[] = [];
    if (demoted) {
      // Lock the grants BEFORE sweeping. A demotion deliberately leaves the grant ACTIVE (its next refresh
      // legitimately re-mints, narrowed to the new role), so nothing else in this tx contends with
      // mintKeyForGrant's `FOR UPDATE`. Without this lock, a refresh that read the PRE-demotion role commits
      // a key carrying the old, higher scopes after our sweep's snapshot — and nothing would ever revoke it.
      await lockUserGrants(tx, input.orgId, input.userId);
      revokedKeyHashes = await revokeUserKeysInTx(tx, input.orgId, input.userId);
    }

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
  /**
   * Active org keys that belong to NOBODY we can name (no grant, and `created_by` is NULL — either minted
   * before 0057 or their creator's account was deleted, which nulls the column by design). A removal cannot
   * revoke these, because it cannot prove they were the leaver's. Non-zero means the removal is NOT a
   * complete revocation: surface it so an admin reviews them in /credentials. See the header note.
   */
  readonly unattributableKeyCount: number;
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
    await lockOrgMembers(tx, input.orgId); // before the census — the guard must not be a TOCTOU
    const { role: currentRole, owners } = await readTargetAndCensus(tx, input.orgId, input.userId);

    if (!canGrantRole(input.actorRole, currentRole)) {
      throw new MemberCeilingError(input.actorRole, `remove a '${currentRole}'`);
    }
    // Removing the sole owner leaves a zero-owner org — unreachable forever (delete the org instead).
    if (currentRole === "owner" && owners === 1) {
      throw new LastOwnerError();
    }

    // Revoke the GRANTS FIRST, then sweep the keys. The order is load-bearing, not cosmetic: the UPDATE
    // takes the auth_grant row locks that mintKeyForGrant's `FOR UPDATE` contends on. Sweeping keys first
    // would let a refresh already holding that lock commit a fresh key behind our snapshot — and since the
    // cold auth lookup checks only `revoked_at is null` (never grant status or membership), that key would
    // authenticate FOREVER for a member we just removed. With grants first, a concurrent minter either
    // already committed (so the sweep below sees its key) or blocks and then refuses on the revoked grant.
    const grantRows = await tx<{ id: string }[]>`
      update auth_grant
         set status = 'revoked', revoked_by = ${input.actorId}, revoked_at = now(),
             revocation_reason = 'member_removed'
       where org_id = ${input.orgId} and user_id = ${input.userId} and status <> 'revoked'
      returning id`;
    // Belt-and-braces: also lock any ALREADY-revoked grant rows the UPDATE's `status <> 'revoked'` filter
    // skipped, so no in-flight mint against them can outrun the sweep either.
    await lockUserGrants(tx, input.orgId, input.userId);
    const revokedKeyHashes = await revokeUserKeysInTx(tx, input.orgId, input.userId);

    await tx`
      delete from memberships where org_id = ${input.orgId} and user_id = ${input.userId}`;

    // Keys we could not attribute to anyone (see the header note) — counted, audited, and returned so the
    // removal reports honestly instead of implying it revoked everything.
    const [orphans] = await tx<{ n: string }[]>`
      select count(*) as n from api_keys
       where org_id = ${input.orgId}
         and revoked_at is null
         and created_by is null
         and grant_id is null`;
    const unattributableKeyCount = Number(orphans?.n ?? 0);

    await appendAuthAuditEntry(tx, input.auditKey, {
      orgId: input.orgId,
      actor: input.actorId,
      eventType: "member_removed",
      targetId: input.userId,
      metadata: {
        role: currentRole,
        revokedKeyCount: revokedKeyHashes.length,
        revokedGrantCount: grantRows.length,
        unattributableKeyCount,
      },
    });
    return { removed: true, revokedKeyHashes, unattributableKeyCount };
  });
}
