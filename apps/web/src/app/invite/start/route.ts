import { NextResponse } from "next/server";

import { setInviteCookie } from "@/server/invite-cookie";
import { loginUrlWithReturn } from "@/server/session";

// dal-gate-allow: pre-auth invite entry — stashes the invite and bounces to login; owns no tenant data and
// establishes no session, so it does not pass through the session gate.

// Per-request (reads the org/token query + sets a cookie).
export const dynamic = "force-dynamic";

/**
 * The pre-auth invite entry point. `/invite/accept` (a Server Component) CANNOT set a cookie during render —
 * Next only permits cookie mutation in a Route Handler or Server Action — so an unauthenticated invitee is
 * redirected HERE. This handler stashes `{org, token}` in the encrypted app-origin invite cookie and bounces
 * to login with a return path back to `/invite/accept?org=…` (path only, token stays in the cookie). After
 * signup they land on the accept page, signed in, and the token is read from the cookie.
 *
 * `no-referrer` so the token-bearing entry URL isn't sent as a Referer to the auth origin.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const org = url.searchParams.get("org") ?? "";
  const token = url.searchParams.get("token") ?? "";

  // Only STASH on a genuine top-level navigation (a clicked invite link). This is a state-changing GET, and a
  // `Set-Cookie` from a cross-site subresource (`<img src=/invite/start?org=ATTACKER&token=…>`) IS stored by
  // the browser (SameSite=Lax restricts sending, not setting) — so without this an attacker could overwrite a
  // victim's invite cookie cross-site. `Sec-Fetch-Dest: document` marks a navigation; a subresource attack is
  // image/empty/etc. When the header is absent (a non-Sec-Fetch client, which also can't mount the attack), we
  // allow it. The redirect below is harmless either way.
  const secFetchDest = request.headers.get("sec-fetch-dest");
  const isTopLevelNav = secFetchDest === null || secFetchDest === "document";
  if (org && token && isTopLevelNav) await setInviteCookie({ org, token });

  const dest = loginUrlWithReturn(
    org ? `/invite/accept?org=${encodeURIComponent(org)}` : "/invite/accept",
  );
  const response = NextResponse.redirect(dest);
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Cache-Control", "no-store");
  return response;
}
