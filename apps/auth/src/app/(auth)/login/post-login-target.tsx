/**
 * Where Better Auth lands the user after a successful login. It must be the **session handoff**
 * (`/session/handoff`) — the auth.→app. producer that reads the just-created auth session, mints the
 * single-use exchange ticket, and 302s to app.'s callback so app. gets a real session. Landing the user
 * on app. directly (the old `callbackURL: APP_BASE_URL`) skipped the handoff entirely → app. had no
 * session → it bounced back to /login (the redirect loop). Same-origin path, so it works in dev + prod.
 *
 * The issuer's `/authorize` bounces an unauthenticated request here with a `?redirect=` back to the
 * original request; honor it (so consent continues after login), defaulting to the handoff for a plain
 * login. Open-redirect guard: accept only a single-leading-slash absolute path (no `//`, no `/\`, no
 * scheme) — anything else falls back to the handoff. `/login` itself is also excluded: sending a
 * just-authenticated user back to the login page is the exact loop this fix removes (a crafted
 * `?redirect=/login` must not re-introduce it). (Better Auth additionally re-validates `callbackURL`
 * server-side against `trustedOrigins`, so this guard is the first of two layers, not the only one.)
 */
export function resolvePostLoginTarget(search: string): string {
  const redirect = new URLSearchParams(search).get("redirect");
  if (redirect && /^\/[^/\\]/.test(redirect) && !/^\/login(?:[/?]|$)/.test(redirect)) {
    return redirect;
  }
  return "/session/handoff";
}
