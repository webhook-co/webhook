import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { headers } from "next/headers";

import { makeAuth } from "@/runtime/auth";
import { readAuthEnv } from "@/runtime/env";

/**
 * Is there a live auth. (IdP) session on this request?
 *
 * The sign-in page never asked. So a user who was ALREADY signed in — because the IdP session outlives app.'s
 * 7-day cookie, or simply because they pressed Back — was shown the login form again and had to re-authenticate
 * for no reason, on a machine where the session was still perfectly valid. Single sign-on that makes you sign
 * in twice is not single sign-on.
 *
 * DB-validated, not cookie-trusted: Better Auth runs with `cookieCache` off, so this is a real session lookup —
 * a signed-out (deleted) session reads as absent immediately, which is what lets GET /logout and this bounce
 * coexist without one undoing the other.
 */
/**
 * Better Auth's session cookie, under either spelling: `__Secure-better-auth.session_token` in prod (the
 * `Secure-` prefix is added over https) and the bare `better-auth.session_token` in dev. Matched on the
 * shared suffix so neither environment is special-cased — and anchored on a cookie-name boundary (start of
 * string, or after the `; ` separator) so a cookie merely ENDING in this name cannot masquerade as it.
 */
const SESSION_COOKIE_RE = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/;

/**
 * Does this request even carry a session cookie? Pure, so it is tested directly.
 *
 * This is not an optimisation of the DB read — it is a REPLACEMENT for it on the one path where the answer
 * is already known. The session is only ever resolved FROM this cookie, so its absence means "no session"
 * with certainty; there is no case where a cookie-less request has a live session that a DB read would find.
 */
export function hasSessionCookie(cookieHeader: string | null): boolean {
  return cookieHeader !== null && SESSION_COOKIE_RE.test(cookieHeader);
}

export async function isSignedIn(): Promise<boolean> {
  // The hot path after EVERY logout: /logout 302s here, and this page then asked the DATABASE whether the
  // user we just signed out is signed in. That question cost a full makeAuth() — 7 Secrets Store reads, a pg
  // Pool over Hyperdrive, and a betterAuth() construction — to learn what the absent cookie says for free.
  // Note this is a strict short-circuit, NOT a trust decision: a cookie that IS present still gets the full
  // DB-validated read below (cookieCache is off), so a revoked session is still dead on arrival.
  if (!hasSessionCookie((await headers()).get("cookie"))) return false;

  const { env, ctx } = await getCloudflareContext({ async: true });
  const auth = await makeAuth(readAuthEnv(env as Parameters<typeof readAuthEnv>[0]), ctx);
  try {
    // getSession reads the session cookie off the request headers; rebuild a Request carrying this one's.
    const request = new Request("https://auth.invalid/", { headers: await headers() });
    return (await auth.getSession(request)) !== null;
  } finally {
    // Never leak the pooled connection — released after the response, exactly like the issuer mounts do.
    ctx.waitUntil(auth.close());
  }
}
