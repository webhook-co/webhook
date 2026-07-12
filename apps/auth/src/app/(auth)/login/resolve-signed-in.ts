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
export async function isSignedIn(): Promise<boolean> {
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
