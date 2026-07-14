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
  // the browser (SameSite=Lax restricts sending, not setting) — so without this an attacker could force-set a
  // victim's invite cookie cross-site. `Sec-Fetch-Dest: document` marks a navigation; the subresource attack is
  // image/empty/etc, which this blocks on every modern browser.
  //
  // A header-ABSENT request is allowed: a legitimate invite click from a very old (pre-Sec-Fetch) browser also
  // sends no header, and rejecting it would break their signup. The residual is narrow and low-impact — it
  // needs a pre-2020 browser AND only lets an attacker OVERWRITE a victim's pending-invite cookie (recoverable
  // from the email; the invite is still valid) or plant an invite the victim would have to navigate to and
  // click Accept on themselves (no worse than the attacker mailing them the link directly).
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
