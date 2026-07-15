import "server-only";

import { cookies } from "next/headers";

import { getSessionSecret } from "./env";
import { SESSION_COOKIE, type Session } from "./session";
import { sessionCookieOptions } from "./session-cookie";
import { signSessionToken, verifySessionToken, type VerifiedSession } from "./session-token";

// Re-mint the session cookie for a DIFFERENT org. Two callers need this — the org switcher and "leave org" —
// and it exists as one function because of a rule that is easy to get wrong twice:
//
//   🔑 The new cookie carries the CURRENT token's expiry forward. It does NOT start a fresh TTL. Re-signing
//   with a full 7 days would let anyone keep a session alive INDEFINITELY just by switching orgs — a
//   session-lifetime bypass hiding inside a convenience feature.
//
// It FAILS CLOSED: if the existing cookie is missing, unverifiable, or already expired, we mint nothing and
// say so. The tempting "harmless" fallback (just use the default TTL) is exactly the bypass above.
//
// It performs NO authorization. The caller MUST already have proven the user belongs to `targetOrgId`.

export type RemintOutcome = "ok" | "no_session";

/**
 * The one place the expiry-preservation + fail-closed rules live — both public re-minters route through here so
 * the security-critical logic ("easy to get wrong twice") exists ONCE. Verifies the current cookie, refuses a
 * missing/unverifiable/expired session, and re-signs the given claims carrying the ORIGINAL deadline forward
 * (never a fresh TTL). The caller decides the claims; this never fabricates or extends a lifetime.
 */
async function remintWith(
  buildClaims: (verified: VerifiedSession) => Session,
): Promise<RemintOutcome> {
  const secret = await getSessionSecret();
  const jar = await cookies();

  const current = jar.get(SESSION_COOKIE)?.value;
  const verified = current ? await verifySessionToken(current, secret) : null;
  if (!verified) return "no_session";

  const remainingSeconds = verified.expiresAt - Math.floor(Date.now() / 1000);
  if (remainingSeconds <= 0) return "no_session"; // never revive a dead session

  const token = await signSessionToken(buildClaims(verified), secret, remainingSeconds);
  jar.set(SESSION_COOKIE, token, { ...sessionCookieOptions(), maxAge: remainingSeconds });
  return "ok";
}

/** Re-issue the session cookie naming `targetOrgId`, preserving the original deadline. No authorization — the
 *  caller MUST already have proven the user belongs to `targetOrgId`. */
export async function remintSessionForOrg(
  session: Pick<Session, "userId" | "user">,
  targetOrgId: string,
): Promise<RemintOutcome> {
  return remintWith(() => ({ userId: session.userId, orgId: targetOrgId, user: session.user }));
}

/**
 * Re-issue the session cookie with an updated user profile (e.g. a display-name edit), keeping the CURRENT org
 * and the ORIGINAL deadline. `session.user.name` is baked into the signed cookie, so without this a name change
 * would only show after next login; re-minting makes it live everywhere immediately (nav, avatar, greeting).
 * Re-mints for the CURRENT session's own user/org (read from the VERIFIED token, not a caller arg), so it can
 * never retarget another principal.
 */
export async function remintSessionForProfile(user: Session["user"]): Promise<RemintOutcome> {
  return remintWith((verified) => ({ userId: verified.userId, orgId: verified.orgId, user }));
}
