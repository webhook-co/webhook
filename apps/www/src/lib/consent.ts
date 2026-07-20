// Cookie-consent layer for the marketing site. `wh_first_touch` is a NON-essential attribution cookie, so
// under ePrivacy it may only be stored AFTER the visitor consents. `wh_consent` records that choice and
// gates everything downstream:
//   - the worker (first-touch-capture.ts) sets first-touch ONLY when consent is already `granted`;
//   - the banner (ConsentBanner.tsx), on Accept, records consent AND promotes the current URL's utm to
//     first-touch in the same gesture; on Reject it records the denial and clears any first-touch cookie.
// This module is the pure, DOM-free decision core — every write the client makes is computed here so the
// whole policy is unit-testable. The consent cookie is deliberately NOT HttpOnly: client JS must read it to
// decide whether to show the banner.

import {
  buildFirstTouchCookie,
  encodeFirstTouch,
  FIRST_TOUCH_COOKIE,
  firstTouchFromQuery,
} from "@webhook-co/shared/first-touch-cookie";

export const CONSENT_COOKIE = "wh_consent";
/** Re-ask for consent after six months (a common, defensible refresh interval). */
export const CONSENT_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

export type ConsentDecision = "granted" | "denied";

/** Prod hosts (webhook.co + subdomains) get a `.webhook.co` cookie so first-touch rides to auth; localhost
 *  / preview hosts get a host-only cookie (no Domain). Anchored on the leading dot so a look-alike host
 *  (`notwebhook.co`, `webhook.co.evil.com`) never matches. */
export function cookieDomain(hostname: string): string | undefined {
  return hostname === "webhook.co" || hostname.endsWith(".webhook.co") ? ".webhook.co" : undefined;
}

/** True when the header already carries a first-touch cookie (first-touch-WINS — never overwrite). */
export function hasFirstTouch(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  return cookieHeader.split(";").some((p) => p.trim().startsWith(`${FIRST_TOUCH_COOKIE}=`));
}

/** The recorded consent decision, or null when the visitor has not chosen yet. Never trusts an arbitrary
 *  value — anything other than the two known decisions reads as "not chosen" (so the banner shows again). */
export function readConsent(cookieHeader: string | null): ConsentDecision | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${CONSENT_COOKIE}=`)) {
      const value = trimmed.slice(CONSENT_COOKIE.length + 1);
      return value === "granted" || value === "denied" ? value : null;
    }
  }
  return null;
}

/** The `Set-Cookie` / `document.cookie` string recording a consent decision. NOT HttpOnly (JS reads it). */
export function buildConsentCookie(
  decision: ConsentDecision,
  opts: { domain?: string } = {},
): string {
  const domain = opts.domain ? `; Domain=${opts.domain}` : "";
  return `${CONSENT_COOKIE}=${decision}; Path=/; Max-Age=${CONSENT_MAX_AGE_SECONDS}; SameSite=Lax; Secure${domain}`;
}

export interface ConsentWrites {
  /** The consent-record cookie to write, always. */
  consent: string;
  /** The first-touch cookie to write (grant + utm present + none yet), the clear cookie (deny), or null. */
  firstTouch: string | null;
}

/**
 * Given a consent decision, the current location, and the current cookies, compute exactly which cookies the
 * client should write. On grant: record consent and, first-touch-WINS, promote the URL's utm to first-touch
 * when one is present and none is set yet. On deny: record the denial and clear any first-touch cookie.
 */
export function consentWrites(
  decision: ConsentDecision,
  location: { search: string; hostname: string },
  cookieHeader: string | null,
): ConsentWrites {
  const domain = cookieDomain(location.hostname);
  const consent = buildConsentCookie(decision, { domain });
  if (decision === "denied") {
    return { consent, firstTouch: buildFirstTouchCookie(null, { domain }) };
  }
  if (hasFirstTouch(cookieHeader)) return { consent, firstTouch: null };
  const encoded = encodeFirstTouch(firstTouchFromQuery(location.search));
  if (!encoded) return { consent, firstTouch: null };
  return { consent, firstTouch: buildFirstTouchCookie(encoded, { domain }) };
}
