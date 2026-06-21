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
