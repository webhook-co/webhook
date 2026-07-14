import { sanitizeReturnPath } from "@webhook-co/shared";

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
 * Open-redirect guard — an ORIGIN CHECK, not a byte-pattern, shared with app. via `sanitizeReturnPath`
 * (`@webhook-co/shared`): strip the control chars a browser strips from a `Location`, reject `//`, `/\`,
 * `/%2f`, `/%5c` origin escapes, then require the resolved origin to be UNCHANGED. This matters because the
 * signed-in bounce (login/page.tsx) calls `redirect()` directly, with none of Better Auth's `trustedOrigins`
 * re-validation behind it. On top of the shared guard we additionally reject `/login` (the resume loop) —
 * that exclusion is specific to this surface and is not part of the general path guard.
 */
export function resolvePostLoginTarget(search: string): string {
  const raw = new URLSearchParams(search).get("redirect");
  // Judge the value against a throwaway base — a same-origin relative path resolves to the base origin.
  const candidate = sanitizeReturnPath(raw, "https://post-login.invalid");
  // Reject a non-same-origin value AND `/login` (sending a just-authenticated user back to the form is the
  // exact loop this fix removes).
  if (candidate === null || /^\/login(?:[/?]|$)/.test(candidate)) {
    return "/session/handoff";
  }
  return candidate;
}
