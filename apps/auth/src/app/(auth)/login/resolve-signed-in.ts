import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getSessionCookie } from "better-auth/cookies";
import { headers } from "next/headers";

import { makeAuth } from "@/runtime/auth";
import { readAuthEnv } from "@/runtime/env";

/**
 * Does this request even carry a session cookie?
 *
 * `getSessionCookie` is BETTER AUTH'S OWN helper, and using it rather than matching the cookie name ourselves
 * is the entire point: the cookie's name is derived from `advanced.cookiePrefix` / `advanced.cookies` and from
 * whether the baseURL is https (which adds the `__Secure-` prefix). Restating that here as a literal or a
 * regex would be a copy of a value this module does not own — and the failure mode of that copy drifting is
 * NASTY and SILENT: `isSignedIn()` would return false for every request, so every already-signed-in user
 * landing on /login gets the sign-in form again, which is the exact bug this file exists to prevent. Unit
 * tests would not catch it either, because they would hardcode the same stale literal. Ask the library.
 *
 * This does NOT read the cookie's value as truth — a forged cookie sails straight past it. It answers only
 * "is there anything here worth a database round-trip for?", and the answer is trusted in one direction only.
 */
async function hasSessionCookie(): Promise<boolean> {
  return (
    getSessionCookie(new Request("https://auth.invalid/", { headers: await headers() })) !== null
  );
}

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
export async function isSignedIn(): Promise<boolean> {
  // The hot path after EVERY logout: /logout 302s here, and this page then asked the DATABASE whether the
  // user we just signed out is signed in. That question cost a full makeAuth() — 7 Secrets Store reads, a pg
  // Pool over Hyperdrive, and a betterAuth() construction — to learn what the absent cookie says for free.
  // Note this is a strict short-circuit, NOT a trust decision: a cookie that IS present still gets the full
  // DB-validated read below (cookieCache is off), so a revoked session is still dead on arrival. It is also
  // fail-closed in the only direction that matters — it can only ever answer "no", never "yes".
  if (!(await hasSessionCookie())) return false;

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
