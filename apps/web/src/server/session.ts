import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

/**
 * The app. session cookie. E5 reads it for the gate semantics but decodes a mock principal;
 * E7 sets it for real from the auth.→app. handoff and hardens the name to `__Host-wh_session`
 * (host-only, set over https).
 */
export const SESSION_COOKIE = "wh_session";

/** Where the gate sends an unauthenticated request — the sign-in surface on auth. */
export const LOGIN_URL = process.env.AUTH_LOGIN_URL ?? "/login";

export interface Session {
  userId: string;
  orgId: string;
  user: { name: string; email: string; image: string | null };
}

// E5 mock principal. E7 replaces this with the session derived from the A-SX exchange (the
// cookie value decoded to the real orgId + userId + profile).
const MOCK_SESSION: Session = {
  userId: "usr_mock_dana",
  orgId: "org_mock_acme",
  user: { name: "Dana Kessler", email: "dana@acme.co", image: null },
};

/**
 * The Data-Access-Layer auth gate. Reads the session cookie; redirects to the sign-in surface
 * when it's absent, otherwise returns the session principal. Call it first-line in every
 * server component, route handler, and server action that touches tenant data — there is no
 * middleware gate (see ADR-0021). The `server-only` import keeps it out of any client bundle.
 */
export async function verifySession(): Promise<Session> {
  const cookie = (await cookies()).get(SESSION_COOKIE);
  if (!cookie?.value) {
    redirect(LOGIN_URL);
  }
  // E7: decode cookie.value → the real session.
  return MOCK_SESSION;
}
