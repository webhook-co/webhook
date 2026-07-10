// Lane C A-SX-2a — read a better-auth user's profile (name/email/image) for the auth.→app. session-exchange
// redeem. The `user` table is the GLOBAL identity realm (text ids, no tenant RLS); webhook_auth has DML on
// it (migration 0016), so the caller passes a webhook_auth-connected client. The session exchange reads the
// profile FRESH here at redeem time (not denormalized into the ticket — A-SX-1/ADR-0033), so it's never
// stale and no identity PII lives in the tenant exchange table.

import type { Sql } from "./client";

export interface AuthUserProfile {
  /** Better Auth requires a name (NOT NULL in the schema). */
  readonly name: string;
  readonly email: string;
  /** The avatar URL — null when the user has none (social login may omit it). */
  readonly image: string | null;
}

/** Resolve a better-auth user's display profile by id (read as webhook_auth). Null if no such user. */
export async function getAuthUserProfile(
  authClient: Sql,
  userId: string,
): Promise<AuthUserProfile | null> {
  const [row] = await authClient<{ name: string; email: string; image: string | null }[]>`
    select "name", "email", "image" from "user" where "id" = ${userId} limit 1`;
  return row ? { name: row.name, email: row.email, image: row.image } : null;
}

/**
 * Permanently delete a user's identity — the right-to-erasure primitive (slice 2.2). Runs as
 * webhook_auth on the GLOBAL identity realm (no tenant RLS/GUC). The delete CASCADES to the user's
 * sessions, accounts, memberships, and their own auth_grants (0001/0003/0013). The two
 * governance-audit references `auth_grant.approved_by` / `revoked_by` on OTHER users' grants are
 * NULLed by their `ON DELETE SET NULL` FKs (migration 0052) rather than blocking the delete.
 *
 * This removes the identity ONLY — it does NOT delete orgs. Any org the user SOLELY owns must be
 * erased first (deleteOrgWithAudit), or it is orphaned owner-less. `verification` rows are keyed by
 * email (no user FK), so pending magic-link tokens for this email are not cascaded — they self-expire
 * via the auth sweeper. Returns true if a user row was removed (false if it was already gone).
 */
export async function deleteUserIdentity(authClient: Sql, userId: string): Promise<boolean> {
  const rows = await authClient<{ id: string }[]>`
    delete from "user" where "id" = ${userId} returning "id"`;
  return rows.length > 0;
}
