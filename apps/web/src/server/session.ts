import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getAuthBaseUrl, getSessionSecret } from "./env";
import { verifySessionToken } from "./session-token";

/**
 * The app. session cookie. Host-only: `__Host-wh_session` in production (the prefix the browser only
 * accepts with Secure + Path=/ + no Domain), a plain name in dev so it works over http://localhost.
 * The value is a signed session token (see session-token.ts), set by the A-SX handoff (auth.→app.).
 */
export const SESSION_COOKIE =
  process.env.NODE_ENV === "production" ? "__Host-wh_session" : "wh_session";

/**
 * Where the gate sends an unauthenticated request — the sign-in surface on **auth.**, never a relative
 * `/login` on app. (which has no login route → 404). Defaults to `${authBase}/login`
 * (`https://auth.webhook.co/login` in prod, the dev auth origin otherwise — see {@link getAuthBaseUrl});
 * an explicit `AUTH_LOGIN_URL` wins (preview/staging). `getAuthBaseUrl()` resolves the prod default even
 * without a request context, so this is correct at module load too.
 */
export const LOGIN_URL = process.env.AUTH_LOGIN_URL || `${getAuthBaseUrl()}/login`;

/** The app. session lifetime — the signed cookie's TTL. The user re-authenticates after this. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface Session {
  userId: string;
  orgId: string;
  user: { name: string; email: string; image: string | null };
}

/**
 * The Data-Access-Layer auth gate. Reads the session cookie and **verifies + decodes its value** (a
 * forged/expired/tampered token is rejected, not trusted) into the session principal; redirects to the
 * sign-in surface when there's no valid session. Call it first-line in every server component, route
 * handler, and server action that touches tenant data — there is no middleware gate (ADR-0021). The
 * `server-only` import keeps it (and the signing secret) out of any client bundle.
 */
export async function verifySession(): Promise<Session> {
  const cookie = (await cookies()).get(SESSION_COOKIE);
  if (!cookie?.value) {
    redirect(LOGIN_URL);
  }
  const session = await verifySessionToken(cookie.value, await getSessionSecret());
  if (!session) {
    redirect(LOGIN_URL);
  }
  return session;
}
