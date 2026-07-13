import "server-only";

import { cookies } from "next/headers";

import { getSessionSecret } from "./env";
import { SESSION_COOKIE, type Session } from "./session";
import { sessionCookieOptions } from "./session-cookie";
import { signSessionToken, verifySessionToken } from "./session-token";

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

/** Re-issue the session cookie naming `targetOrgId`, preserving the original deadline. */
export async function remintSessionForOrg(
  session: Pick<Session, "userId" | "user">,
  targetOrgId: string,
): Promise<RemintOutcome> {
  const secret = await getSessionSecret();
  const jar = await cookies();

  const current = jar.get(SESSION_COOKIE)?.value;
  const verified = current ? await verifySessionToken(current, secret) : null;
  if (!verified) return "no_session";

  const remainingSeconds = verified.expiresAt - Math.floor(Date.now() / 1000);
  if (remainingSeconds <= 0) return "no_session"; // never revive a dead session

  const token = await signSessionToken(
    { userId: session.userId, orgId: targetOrgId, user: session.user },
    secret,
    remainingSeconds,
  );
  jar.set(SESSION_COOKIE, token, { ...sessionCookieOptions(), maxAge: remainingSeconds });
  return "ok";
}
