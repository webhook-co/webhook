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

/** The onboarding-relevant slice of a user's identity — read as webhook_auth. */
export interface OnboardingState {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly name: string;
  /** Null until onboarding is finished. Its presence is the gate. */
  readonly onboardedAt: Date | null;
  /** So the gate can treat users who predate the feature as already-onboarded. */
  readonly createdAt: Date;
}

/**
 * Read a user's onboarding state (as webhook_auth). Null if no such user.
 *
 * `webhook_app` deliberately CANNOT read these columns — the `user` table has no per-org RLS and webhook_app
 * has no grant on it (migration 0068), so onboarding state, like every other identity fact, is reached only
 * through webhook_auth. That is why this is an RPC target, not a tenant query.
 */
export async function readOnboardingState(
  authClient: Sql,
  userId: string,
): Promise<OnboardingState | null> {
  const [row] = await authClient<
    {
      firstName: string | null;
      lastName: string | null;
      name: string;
      onboardedAt: Date | null;
      createdAt: Date;
    }[]
  >`
    select "firstName", "lastName", "name", "onboardedAt", "createdAt"
    from "user" where "id" = ${userId} limit 1`;
  return row ?? null;
}

/**
 * Persist the profile a user entered (or corrected) during onboarding, and STAMP `onboardedAt` — the two are
 * one write, on purpose: `onboardedAt` is the gate, so it must not be set until the profile it gates on has
 * actually landed. Runs as webhook_auth on the identity realm (webhook_app never writes `user`, even
 * indirectly — the same boundary account-deletion crosses by RPC rather than by a SECURITY DEFINER writer).
 *
 * Idempotent by design: onboarding can be re-submitted (a flaky network, a double click), and re-stamping a
 * later `onboardedAt` over an earlier one changes nothing that matters.
 *
 * The composite `name` is ALSO updated, to the corrected "first last". This matters: the app renders
 * `session.user.name` (the account page, the avatar, greetings) — NOT the first/last split — so a user who
 * fixes GitHub's "Ada L." to "Ada Lovelace", or a magic-link user whose name defaulted to their email
 * local-part, would otherwise see their correction persisted but invisible everywhere the product shows their
 * name. `name` is NOT NULL in Better Auth's schema, so we only overwrite it when the composite is non-empty
 * (coalesce back to the existing name otherwise) — the action already requires a first name, so in practice
 * it always is.
 *
 * Empty strings are stored as NULL, not "", for firstName/lastName: an absent last name is absent, not blank,
 * so the two read the same everywhere downstream.
 */
export async function completeOnboarding(
  authClient: Sql,
  input: { userId: string; firstName: string; lastName: string; onboardedAt: Date },
): Promise<boolean> {
  const first = input.firstName.trim() || null;
  const last = input.lastName.trim() || null;
  const composite = [first, last].filter(Boolean).join(" ");
  const rows = await authClient<{ id: string }[]>`
    update "user"
    set "firstName" = ${first},
        "lastName" = ${last},
        "name" = coalesce(nullif(${composite}, ''), "name"),
        "onboardedAt" = ${input.onboardedAt}
    where "id" = ${input.userId}
    returning "id"`;
  return rows.length > 0;
}

/**
 * Update just a user's DISPLAY name — the `name` column the whole app renders (`session.user.name`, the
 * avatar, greetings). Runs as webhook_auth on the identity realm, the same boundary onboarding writes cross.
 *
 * Unlike {@link completeOnboarding} this does NOT touch `onboardedAt` (an already-onboarded user editing their
 * name must not re-stamp the gate) and does NOT rewrite `firstName`/`lastName` — those are onboarding artifacts
 * that nothing renders after onboarding; leaving them avoids a lossy re-split of a free-form display name.
 *
 * `name` is NOT NULL in Better Auth's schema, so an empty/whitespace name is refused (returns false without a
 * write) — defense in depth behind the action's own non-empty validation, so a bad request can never blank an
 * identity. Returns false when no such user exists.
 */
export async function updateUserName(
  authClient: Sql,
  input: { userId: string; name: string },
): Promise<boolean> {
  const name = input.name.trim();
  if (name.length === 0) return false;
  const rows = await authClient<{ id: string }[]>`
    update "user" set "name" = ${name} where "id" = ${input.userId} returning "id"`;
  return rows.length > 0;
}

/**
 * Point a user's avatar at an uploaded R2 object (or clear it with null). Runs as webhook_auth on the identity
 * realm — `imageKey` is `input: false`, so this app-side RPC write is the ONLY way it's ever set (never a
 * client). The route handler has already validated + stored the image before calling this. Returns false when
 * no such user exists.
 */
export async function updateUserImageKey(
  authClient: Sql,
  input: { userId: string; imageKey: string | null },
): Promise<boolean> {
  const rows = await authClient<{ id: string }[]>`
    update "user" set "imageKey" = ${input.imageKey} where "id" = ${input.userId} returning "id"`;
  return rows.length > 0;
}

// ── Email-change ceremony (PR 8) ─────────────────────────────────────────────────────────────────────────
// The custom OWASP email-change flow (Better Auth's built-in is not used). All these run as webhook_auth on
// the identity realm. The OTP HASH lives in `pending_email_change` (0081), readable by webhook_auth ONLY.

/** The new address collides with an existing account (case-insensitively, via the citext `user_email_key`). */
export class EmailTakenError extends Error {
  constructor() {
    super("email already in use");
    this.name = "EmailTakenError";
  }
}

/** A 23505 whose constraint mentions `email` — the citext uniqueness backstop tripping at commit. */
function isEmailTaken(error: unknown): boolean {
  const e = error as { code?: unknown; constraint_name?: unknown } | null;
  return (
    !!e &&
    e.code === "23505" &&
    typeof e.constraint_name === "string" &&
    e.constraint_name.includes("email")
  );
}

/** True if SOME OTHER user already holds this email (citext = case-insensitive). Early check at start-time so
 *  we don't send an OTP toward a change that can't commit. The commit still re-checks (TOCTOU). */
export async function emailInUseByAnother(
  authClient: Sql,
  input: { email: string; exceptUserId: string },
): Promise<boolean> {
  const [row] = await authClient<{ id: string }[]>`
    select "id" from "user" where "email" = ${input.email} and "id" <> ${input.exceptUserId} limit 1`;
  return row !== undefined;
}

/** Upsert the in-flight email change (one per user): store the OTP hash + target + expiry, reset attempts. */
export async function upsertPendingEmailChange(
  authClient: Sql,
  input: { userId: string; newEmail: string; codeHash: Uint8Array; expiresAt: Date },
): Promise<void> {
  await authClient`
    insert into pending_email_change (user_id, new_email, code_hash, expires_at, attempts)
    values (${input.userId}, ${input.newEmail}, ${Buffer.from(input.codeHash)}, ${input.expiresAt}, 0)
    on conflict (user_id) do update set
      new_email = excluded.new_email,
      code_hash = excluded.code_hash,
      expires_at = excluded.expires_at,
      attempts = 0,
      created_at = now()`;
}

export interface PendingEmailChange {
  readonly newEmail: string;
  readonly codeHash: Buffer;
  readonly expiresAt: Date;
  readonly attempts: number;
}

/** Read the in-flight change for a user (null if none). */
export async function readPendingEmailChange(
  authClient: Sql,
  userId: string,
): Promise<PendingEmailChange | null> {
  const [row] = await authClient<
    { new_email: string; code_hash: Buffer; expires_at: Date; attempts: number }[]
  >`select new_email, code_hash, expires_at, attempts
      from pending_email_change where user_id = ${userId} limit 1`;
  return row
    ? {
        newEmail: row.new_email,
        codeHash: Buffer.from(row.code_hash),
        expiresAt: row.expires_at,
        attempts: row.attempts,
      }
    : null;
}

/** Bump the failed-verify counter; returns the NEW count (the verify path locks out after a few misses). */
export async function bumpPendingEmailChangeAttempts(
  authClient: Sql,
  userId: string,
): Promise<number> {
  const [row] = await authClient<{ attempts: number }[]>`
    update pending_email_change set attempts = attempts + 1 where user_id = ${userId} returning attempts`;
  return row?.attempts ?? 0;
}

export async function deletePendingEmailChange(authClient: Sql, userId: string): Promise<void> {
  await authClient`delete from pending_email_change where user_id = ${userId}`;
}

/**
 * Commit the change: set the (lowercased) email + mark it verified (the OTP already proved control of the
 * account, and the address was chosen by the authenticated user). Throws {@link EmailTakenError} on the citext
 * unique — the TOCTOU backstop against another account taking a case-variant between start and commit.
 */
export async function commitEmailChange(
  authClient: Sql,
  input: { userId: string; newEmail: string },
): Promise<boolean> {
  const email = input.newEmail.toLowerCase();
  try {
    const rows = await authClient<{ id: string }[]>`
      update "user" set "email" = ${email}, "emailVerified" = true
        where "id" = ${input.userId} returning "id"`;
    return rows.length > 0;
  } catch (error) {
    if (isEmailTaken(error)) throw new EmailTakenError();
    throw error;
  }
}

/**
 * Revoke the user's IdP sessions — ALL of them. The dashboard runs on a stateless signed cookie that carries
 * no IdP-session id, so there is no "current" IdP session to keep; the browser doing the change keeps working
 * on its re-minted cookie until it expires, and no session can be renewed/handed-off after this. Returns the
 * number of sessions revoked.
 */
export async function deleteAllUserSessions(authClient: Sql, userId: string): Promise<number> {
  const rows = await authClient<{ id: string }[]>`
    delete from "session" where "userId" = ${userId} returning "id"`;
  return rows.length;
}

/**
 * Kill any in-flight magic-link / email-verification for the given addresses. `verification` is keyed by
 * `identifier` = the email (no user FK), so on an email change BOTH the old and the new address must be purged
 * — an outstanding magic link to the OLD address must not survive the change.
 */
export async function purgeVerificationsForEmails(
  authClient: Sql,
  emails: readonly string[],
): Promise<void> {
  if (emails.length === 0) return;
  await authClient`delete from "verification" where "identifier" in ${authClient(emails as string[])}`;
}

// ── Login methods (social `account` rows) ────────────────────────────────────────────────────────────────

export interface LoginMethodRow {
  readonly providerId: string;
  readonly accountId: string;
  readonly linkedAt: Date;
}

/** List a user's linked social sign-ins (rows in `account`), newest first. Read as webhook_auth. */
export async function listLoginMethods(authClient: Sql, userId: string): Promise<LoginMethodRow[]> {
  const rows = await authClient<{ providerId: string; accountId: string; createdAt: Date }[]>`
    select "providerId", "accountId", "createdAt"
      from "account" where "userId" = ${userId} order by "createdAt" desc`;
  return rows.map((r) => ({
    providerId: r.providerId,
    accountId: r.accountId,
    linkedAt: r.createdAt,
  }));
}

/** How many social sign-ins the user has linked (for the last-method guard). */
export async function countLoginMethods(authClient: Sql, userId: string): Promise<number> {
  const [row] = await authClient<{ n: number }[]>`
    select count(*)::int as n from "account" where "userId" = ${userId}`;
  return row?.n ?? 0;
}

/** Remove one linked social sign-in. Returns true if a row was deleted (false if it wasn't there). The
 *  last-method guard is the CALLER's responsibility — this is the raw delete. */
export async function unlinkLoginMethod(
  authClient: Sql,
  input: { userId: string; providerId: string; accountId: string },
): Promise<boolean> {
  const rows = await authClient<{ id: string }[]>`
    delete from "account"
      where "userId" = ${input.userId}
        and "providerId" = ${input.providerId}
        and "accountId" = ${input.accountId}
      returning "id"`;
  return rows.length > 0;
}
