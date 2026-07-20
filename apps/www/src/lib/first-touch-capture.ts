// First-touch acquisition capture (activation follow-up), CONSENT-GATED. The www worker already reads utm
// server-side for analytics; here it ALSO sets a first-party `.webhook.co` first-touch cookie on an HTML
// page view that carries utm — but ONLY when the request already carries `wh_consent=granted`. That covers a
// returning, already-consented visitor arriving via a new marketing link (HttpOnly, reliable even with JS
// disabled). The FIRST consent moment — showing the banner, recording the choice, promoting the landing
// URL's utm — is handled client-side (consent.ts / ConsentBanner.tsx), because a page already served can't
// be un-sent. First-touch-WINS. Best-effort + TOTAL: any issue returns the original response unchanged,
// because serving a page must NEVER depend on this.

import {
  buildFirstTouchCookie,
  encodeFirstTouch,
  firstTouchFromQuery,
} from "@webhook-co/shared/first-touch-cookie";

import { cookieDomain, hasFirstTouch, readConsent } from "./consent";

/**
 * Set the first-party first-touch cookie on an HTML page view that carries utm — gated on prior consent
 * (`wh_consent=granted`) and first-touch-WINS (only when absent). Server-side + HttpOnly. Returns the
 * response with an added `Set-Cookie` when it captures, else the original response untouched. Never throws.
 */
export function withFirstTouchCookie(request: Request, response: Response): Response {
  try {
    if (!(response.headers.get("content-type") ?? "").includes("text/html")) return response;
    const cookieHeader = request.headers.get("cookie");
    // ePrivacy: `wh_first_touch` is a non-essential attribution cookie — never set it without prior consent.
    if (readConsent(cookieHeader) !== "granted") return response;
    if (hasFirstTouch(cookieHeader)) return response;
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
