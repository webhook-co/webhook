import "server-only";
import { sessionCookieName } from "./session-cookie";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getAuthBaseUrl, getSessionSecret } from "./env";
import { verifySessionToken } from "./session-token";

/**
 * The app. session cookie. Host-only: `__Host-wh_session` in production (the prefix the browser only
 * accepts with Secure + Path=/ + no Domain), a plain name in dev so it works over http://localhost.
 * The value is a signed session token (see session-token.ts), set by the A-SX handoff (auth.→app.).
 */
export const SESSION_COOKIE = sessionCookieName();

/**
 * Where the gate sends an unauthenticated request — the sign-in surface on **auth.**, never a relative
 * `/login` on app. (which has no login route → 404). Defaults to `${authBase}/login`
 * (`https://auth.webhook.co/login` in prod, the dev auth origin otherwise — see {@link getAuthBaseUrl});
 * an explicit `AUTH_LOGIN_URL` wins (preview/staging). `getAuthBaseUrl()` resolves the prod default even
 * without a request context, so this is correct at module load too.
 */
export const LOGIN_URL = process.env.AUTH_LOGIN_URL || `${getAuthBaseUrl()}/login`;

/**
 * Where SIGNING OUT goes — auth.'s `/logout`, which ends the IdP session, not `/login`, which now RESUMES it.
 *
 * These two must not be confused, and the distinction is load-bearing. The unauthenticated GATE (an absent or
 * expired app. cookie) sends you to {@link LOGIN_URL}, and auth. is expected to sign you straight back in if
 * its own session is still live — that is single sign-on working. Logout is the opposite intent: it must
 * DESTROY that session. Pointed at /login it would do the reverse of what the user asked, bouncing them back
 * into the dashboard they just left.
 */
export const LOGOUT_URL = process.env.AUTH_LOGOUT_URL || `${getAuthBaseUrl()}/logout`;

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
  const session = await getSessionOrNull();
  if (!session) {
    redirect(LOGIN_URL);
  }
  return session;
}

/**
 * The non-redirecting read behind {@link verifySession}: returns the verified session principal, or `null`
 * when there's no valid cookie. For the few surfaces that must BRANCH on auth rather than bounce — the invite
 * page, which for an unauthenticated visitor stashes the invite and builds its OWN login URL (with a return
 * path) instead of the gate's default redirect.
 */
export async function getSessionOrNull(): Promise<Session | null> {
  const cookie = (await cookies()).get(SESSION_COOKIE);
  if (!cookie?.value) return null;
  return verifySessionToken(cookie.value, await getSessionSecret());
}

/**
 * An OPT-IN login URL that returns to an app path after the auth.→app. handoff — the ONLY caller is the invite
 * page (the shared `verifySession()` gate keeps its no-returnTo default, so no other gated URL leaks into
 * auth-origin logs). `path` is a RELATIVE app path (e.g. `/invite/accept?org=X`); it rides as a nested `next`
 * inside the handoff target, encoded EXACTLY ONCE so it survives Better Auth's callbackURL guard (a raw nested
 * `?` would 403). app.'s callback re-validates it same-origin before acting on it.
 */
export function loginUrlWithReturn(path: string): string {
  const handoffTarget = `/session/handoff?next=${encodeURIComponent(path)}`;
  return `${LOGIN_URL}?redirect=${encodeURIComponent(handoffTarget)}`;
}
