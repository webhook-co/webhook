/**
 * Where Better Auth lands the user after a successful login. It must be the **session handoff**
 * (`/session/handoff`) — the auth.→app. producer that reads the just-created auth session, mints the
 * single-use exchange ticket, and 302s to app.'s callback so app. gets a real session. Landing the user
 * on app. directly (the old `callbackURL: APP_BASE_URL`) skipped the handoff entirely → app. had no
 * session → it bounced back to /login (the redirect loop). Same-origin path, so it works in dev + prod.
 *
 * The issuer's `/authorize` bounces an unauthenticated request here with a `?redirect=` back to the
 * original request; honor it (so consent continues after login), defaulting to the handoff for a plain
 * login. `/login` itself is excluded: sending a just-authenticated user back to the login page is the exact
 * loop this fix removes (a crafted `?redirect=/login` must not re-introduce it).
 *
 * Open-redirect guard — an ORIGIN CHECK, not a byte-pattern. It used to be `/^\/[^/\\]/`, matching only the
 * first two characters, and that is not safe as a standalone gate: browsers STRIP tab/newline/CR while
 * parsing a `Location`, so `/\t/evil.com` becomes `//evil.com` → `https://evil.com`, and the char-class
 * happily accepted a tab as the second byte. This mattered the moment the guard became the ONLY layer — the
 * signed-in bounce (login/page.tsx) calls `redirect()` directly, with none of Better Auth's `trustedOrigins`
 * re-validation behind it. So: strip the control chars the browser would strip, then resolve the value
 * against a throwaway base and require the origin to be UNCHANGED — a real same-origin test, which no `//`,
 * `/\`, `\t//`, or scheme can pass.
 */
export function resolvePostLoginTarget(search: string): string {
  const raw = new URLSearchParams(search).get("redirect");
  if (raw === null) return "/session/handoff";

  // Exactly the characters a URL parser discards from a Location, so we judge the value the browser will act
  // on, not the one on the wire.
  const candidate = raw.replace(/[\t\n\r]/g, "");
  // Must be an absolute path with an actual destination after the slash (a bare "/" is not a post-login
  // target — it just re-enters this page's host root), and never /login (the loop).
  if (!/^\/[^/\\]/.test(candidate) || /^\/login(?:[/?]|$)/.test(candidate)) {
    return "/session/handoff";
  }

  const BASE = "https://post-login.invalid";
  try {
    // Same-origin iff resolving against BASE leaves the origin untouched. `//evil.com` and `/\evil.com`
    // resolve to a DIFFERENT origin and are rejected here; a genuine path keeps BASE's origin.
    if (new URL(candidate, BASE).origin === BASE) return candidate;
  } catch {
    // An unparseable value is not a destination we trust.
  }
  return "/session/handoff";
}
