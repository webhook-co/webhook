// First-touch acquisition capture (activation follow-up). The www worker already reads utm server-side for
// analytics; here it ALSO sets a first-party `.webhook.co` first-touch cookie on an HTML page view that
// carries utm, first-touch-WINS. On the shared parent apex the cookie rides to auth.webhook.co and is read by
// the signup hook — no client JS, HttpOnly, reliable even with JS disabled. Best-effort + TOTAL: any issue
// returns the original response unchanged, because serving a page must NEVER depend on this.

import {
  buildFirstTouchCookie,
  encodeFirstTouch,
  FIRST_TOUCH_COOKIE,
  firstTouchFromQuery,
} from "@webhook-co/shared/first-touch-cookie";

/** Does the request already carry a first-touch cookie? (first-touch-WINS — never overwrite an earlier one.) */
function hasFirstTouch(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  return cookieHeader.split(";").some((p) => p.trim().startsWith(`${FIRST_TOUCH_COOKIE}=`));
}

/** Prod hosts (webhook.co + subdomains) get a `.webhook.co` cookie so it rides to auth; localhost / preview
 *  hosts get a host-only cookie (no Domain). */
function cookieDomain(hostname: string): string | undefined {
  return hostname === "webhook.co" || hostname.endsWith(".webhook.co") ? ".webhook.co" : undefined;
}

/**
 * Set the first-party first-touch cookie on an HTML page view that carries utm (first-touch-WINS: only when
 * absent). Server-side + HttpOnly. Returns the response with an added `Set-Cookie` when it captures, else the
 * original response untouched. Never throws.
 */
export function withFirstTouchCookie(request: Request, response: Response): Response {
  try {
    if (!(response.headers.get("content-type") ?? "").includes("text/html")) return response;
    if (hasFirstTouch(request.headers.get("cookie"))) return response;
    const url = new URL(request.url);
    const encoded = encodeFirstTouch(firstTouchFromQuery(url.search));
    if (!encoded) return response; // no utm present → nothing to capture
    const cookie = `${buildFirstTouchCookie(encoded, { domain: cookieDomain(url.hostname) })}; HttpOnly`;
    const headers = new Headers(response.headers);
    headers.append("set-cookie", cookie);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response; // serving the page must never depend on capture
  }
}
