import { randomUUID } from "node:crypto";

import { canGrantRole, type MembershipRole } from "@webhook-co/shared";

import { appendAuthAuditEntry } from "./auth-audit";
import { withTenant, type Sql } from "./client";
import { mintCredential, type CredentialHasher } from "./credential";

// Org invitations (Lane 2.5). An invite is a ≥256-bit CSPRNG token shown once (in the emailed link) and
// stored ONLY as a keyed hash — accept looks it up by hash, so the DB never holds the secret. Accept is
// single-use: one atomic UPDATE flips accepted_at (guarded on pending + unexpired + unrevoked + token +
// email match), and the membership is inserted in the SAME transaction, so an invite can create at most one
// membership and a replay is a no-op. Everything runs under the org's RLS context (the org is known from the
// invite link). This is the token/consume/RLS/ceiling core.
//
// FOLLOW-UPS the web action/UI slice MUST honour (this DB layer TRUSTS its inputs):
//   - acceptInvite.userEmail must be the session's VERIFIED email, never client input.
//   - createInvite.inviterRole must be derived server-side (requireOrgAccess), never from the client.
//   - The token is a plain whinv_<secret> — it does NOT embed the org, so the accept link must carry the
//     invite's orgId and pass it to acceptInvite (a wrong org just yields "invalid", failing closed).
//   - Emit auth_audit_event on create/accept/revoke; rate-limit create (spam) + accept (brute-force).

/** Invite token prefix — "webhook invite". Mirrors the api-key/ingest prefixes. */
const INVITE_TOKEN_PREFIX = "whinv";

/** Default invite lifetime: 7 days (the plan's TTL). */
export const INVITE_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Thrown when an inviter tries to grant a role above their own (the invite ceiling — you can't hand out
 *  more than you hold). Caught by the caller and surfaced as a refusal. */
export class InviteRoleCeilingError extends Error {
  constructor(
    readonly inviterRole: string,
    readonly targetRole: string,
  ) {
    super(`cannot invite at role '${targetRole}' — it exceeds the inviter's role '${inviterRole}'`);
    this.name = "InviteRoleCeilingError";
  }
}

export interface CreateInviteInput {
  readonly orgId: string;
  /** The invitee's email. The accepting user's verified email must match this (case-insensitive). */
  readonly invitedEmail: string;
  readonly role: MembershipRole;
  /** The inviting user (stored as invited_by). */
  readonly invitedBy: string;
  /**
   * The inviter's own role — the ceiling: they cannot invite above it. MUST be derived server-side (from
   * requireOrgAccess / readMembershipRole), NEVER trusted from the client, or the ceiling is bypassable.
   */
  readonly inviterRole: MembershipRole;
  /** HMAC key for the tamper-evident auth_audit_event entry (invite_created), written in the same tx. */
  readonly auditKey: CryptoKey;
  readonly ttlMs?: number;
  /** Injected clock (ms) for deterministic tests. */
  readonly now?: number;
}

export interface CreatedInvite {
  readonly id: string;
  /** The plaintext token — returned ONCE (for the email link); never stored, never re-derivable. */
  readonly token: string;
  readonly invitedEmail: string;
  readonly role: MembershipRole;
  readonly expiresAt: string;
}

/**
 * Create a pending invite. Enforces the role ceiling (canGrantRole) BEFORE minting — an admin can invite an
 * admin or member, never an owner. Mints a fresh token, stores only its hash, and returns the plaintext once.
 */
export async function createInvite(
  app: Sql,
  hasher: CredentialHasher,
  input: CreateInviteInput,
): Promise<CreatedInvite> {
  // A blank email is a fail-open corner: an empty invited_email would match an empty userEmail on accept.
  // Reject it here (the DB also CHECKs non-empty as defense in depth).
  if (input.invitedEmail.trim() === "") {
    throw new Error("invite requires a non-empty invited email");
  }
  if (!canGrantRole(input.inviterRole, input.role)) {
    throw new InviteRoleCeilingError(input.inviterRole, input.role);
  }
  // NOTE: the role ceiling is frozen at creation time. If the inviter is later demoted before the invite is
  // accepted, the invite still accepts at the stored role — revoke is the mitigation (v1, by design).
  const id = randomUUID();
  const now = input.now ?? Date.now();
  const expiresAt = new Date(now + (input.ttlMs ?? INVITE_DEFAULT_TTL_MS));
  const { plaintext, keyHash, start } = mintCredential(INVITE_TOKEN_PREFIX, hasher);

  await withTenant(app, input.orgId, async (tx) => {
    await tx`insert into org_invites (id, org_id, token_hash, start, invited_email, role, invited_by, expires_at)
       values (${id}, ${input.orgId}, ${keyHash}, ${start}, ${input.invitedEmail}, ${input.role}, ${input.invitedBy}, ${expiresAt})`;
    // Tamper-evident audit in the SAME tx. No email in metadata (PII) — targetId links to the invite row.
    await appendAuthAuditEntry(tx, input.auditKey, {
      orgId: input.orgId,
      actor: input.invitedBy,
      eventType: "invite_created",
      targetId: id,
      metadata: { role: input.role },
    });
  });

  return {
    id,
    token: plaintext,
    invitedEmail: input.invitedEmail,
    role: input.role,
    expiresAt: expiresAt.toISOString(),
  };
}

export interface AcceptInviteInput {
  readonly orgId: string;
  /** The plaintext token the accepting user presents. */
  readonly token: string;
  /** The accepting user's id (becomes the membership + accepted_by). */
  readonly userId: string;
  /** The accepting user's (verified) email — MUST match the invited_email (case-insensitive). */
  readonly userEmail: string;
  /** HMAC key for the auth_audit_event (invite_accepted) written in the accept tx. */
  readonly auditKey: CryptoKey;
  readonly now?: number;
}

export type AcceptInviteResult =
  | { readonly status: "accepted"; readonly role: MembershipRole }
  /** Not found, expired, already consumed, revoked, or the email didn't match — indistinguishable on purpose. */
  | { readonly status: "invalid" };

/**
 * Accept an invite: single-use, atomic, membership created in the same transaction. The consume gate is one
 * UPDATE that flips accepted_at only if the invite is pending, unexpired, unrevoked, the token hashes to it,
 * AND the accepting user's email matches — a replay/expired/mismatch matches no row and returns "invalid".
 * On success the membership is inserted (idempotent if somehow already a member) in the same tx.
 */
export async function acceptInvite(
  app: Sql,
  hasher: CredentialHasher,
  input: AcceptInviteInput,
): Promise<AcceptInviteResult> {
  const candidates = hasher.candidates(input.token); // current + previous peppers (rotation-safe)
  const now = new Date(input.now ?? Date.now());

  return withTenant(app, input.orgId, async (tx) => {
    // Iterate candidates one hash at a time — postgres.js doesn't bind a Buffer[] as bytea[] for `= any()`
    // (mirrors the api-key / refresh-token cold lookup). token_hash is unique, so at most one matches; the
    // per-candidate UPDATE is itself the atomic single-use gate.
    for (const candidate of candidates) {
      const rows = await tx<{ id: string; role: MembershipRole }[]>`
        update org_invites
           set accepted_at = ${now}, accepted_by = ${input.userId}
         where org_id = ${input.orgId}
           and token_hash = ${candidate}
           and invited_email = ${input.userEmail}
           and accepted_at is null
           and revoked_at is null
           and expires_at > ${now}
        returning id, role`;
      const invite = rows[0];
      if (invite) {
        // Create the membership. If the user is ALREADY a member, accept does NOT change their role — a
        // stale invite must never silently escalate (or demote) an existing member. So `do nothing`, then
        // return the role that is actually in the DB (the freshly-inserted one, or the pre-existing one).
        const inserted = await tx<{ role: MembershipRole }[]>`
          insert into memberships (org_id, user_id, role)
          values (${input.orgId}, ${input.userId}, ${invite.role})
          on conflict (org_id, user_id) do nothing
          returning role`;
        let role = inserted[0]?.role;
        if (role === undefined) {
          const [existing] = await tx<{ role: MembershipRole }[]>`
            select role from memberships where org_id = ${input.orgId} and user_id = ${input.userId}`;
          role = existing?.role ?? invite.role;
        }
        await appendAuthAuditEntry(tx, input.auditKey, {
          orgId: input.orgId,
          actor: input.userId,
          eventType: "invite_accepted",
          targetId: invite.id,
          metadata: { role },
        });
        return { status: "accepted" as const, role };
      }
    }
    return { status: "invalid" as const };
  });
}

/** Revoke a pending invite. Returns true if a pending (unaccepted, unrevoked) invite was revoked. */
export async function revokeInvite(
  app: Sql,
  input: { orgId: string; inviteId: string; revokedBy: string; auditKey: CryptoKey; now?: number },
): Promise<boolean> {
  const now = new Date(input.now ?? Date.now());
  return withTenant(app, input.orgId, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      update org_invites set revoked_at = ${now}
       where id = ${input.inviteId} and org_id = ${input.orgId}
         and accepted_at is null and revoked_at is null
      returning id`;
    if (rows.length === 0) return false; // already accepted / revoked / unknown — nothing to audit
    await appendAuthAuditEntry(tx, input.auditKey, {
      orgId: input.orgId,
      actor: input.revokedBy,
      eventType: "invite_revoked",
      targetId: input.inviteId,
    });
    return true;
  });
}

export interface PendingInvite {
  readonly id: string;
  readonly invitedEmail: string;
  readonly role: MembershipRole;
  /** The non-secret token display handle. */
  readonly start: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

/** List an org's PENDING invites (not accepted / revoked / expired), newest first. Never returns a token. */
export async function listPendingInvites(
  app: Sql,
  orgId: string,
  now: number = Date.now(),
): Promise<PendingInvite[]> {
  const at = new Date(now);
  const rows = await withTenant(
    app,
    orgId,
    (tx) =>
      tx<
        {
          id: string;
          invited_email: string;
          role: MembershipRole;
          start: string;
          expires_at: Date;
          created_at: Date;
        }[]
      >`
        select id, invited_email, role, start, expires_at, created_at
          from org_invites
         where org_id = ${orgId} and accepted_at is null and revoked_at is null and expires_at > ${at}
         order by created_at desc`,
  );
  return rows.map((r) => ({
    id: r.id,
    invitedEmail: r.invited_email,
    role: r.role,
    start: r.start,
    expiresAt: r.expires_at.toISOString(),
    createdAt: r.created_at.toISOString(),
  }));
}
