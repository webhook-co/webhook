# ADR-0128: first-touch attribution via a consent-gated first-party cookie

- **Status:** Accepted
- **Date:** 2026-07-20
- **Relates to / amends:** [ADR-0127](0127-activation-instrumentation.md) (activation instrumentation — this
  changes only the *first-touch acquisition* mechanism it described as "cookieless"; the milestone/rollup and
  weekly-review design there are unchanged). Also AGENTS.md compliance-by-design and the brand-voice/privacy
  constraints.

## Context

ADR-0127 specified a **cookieless** first-touch: the marketing CTA appends `?utm_*` to `auth.webhook.co/login`,
the login page folds them into the Better Auth `callbackURL`, and the signup hook reads them off the endpoint
context. Implementing it surfaced two problems:

1. **It's fragile.** The utm has to survive a three-hop propagation (marketing CTA → `app.webhook.co` →
   `/login` → magic-link verify). `app.webhook.co` redirects a signed-out visitor before any JS runs and drops
   the query string, so the tags are lost unless every entry path is threaded perfectly.
2. **It can't attribute OAuth signups.** A Google/GitHub round-trip does not carry our `callbackURL` utm back
   to the create hook reliably, so `first_touch_*` was best-effort *null* for exactly the signups we most want
   to measure.

A **first-party `.webhook.co` cookie** solves both: set once on the marketing site, it rides to
`auth.webhook.co` on the shared parent apex automatically, for magic-link **and** OAuth, with no per-path
threading. But `wh_first_touch` is a **non-essential attribution cookie** — not required to deliver the
service — so under the EU ePrivacy Directive it may only be stored with the visitor's **prior consent**.
GDPR "legitimate interests" (the basis ADR-0127 assumed) covers the *processing* but not ePrivacy's
*consent-to-store* requirement. So the cookie needs a consent gate.

## Decision

**Capture first-touch with a consent-gated first-party cookie, and add a minimal cookie banner to obtain that
consent.**

- **`wh_first_touch`** — first-party, `Domain=.webhook.co` on prod hosts (host-only on localhost/preview),
  `SameSite=Lax; Secure`, 90-day `Max-Age`, **first-touch-wins** (written once, never overwritten). Value is
  the compact utm triple (`s=…&m=…&c=…`), **utm only, never PII**. Wire format single-sourced in
  `@webhook-co/shared/first-touch-cookie`.
- **`wh_consent`** — records the choice (`granted` / `denied`), `SameSite=Lax; Secure`, 6-month `Max-Age`,
  **not HttpOnly** (client JS reads it to decide whether to show the banner). Recording a consent choice is
  itself strictly-necessary, so this cookie needs no consent.
- **The gate:** the worker sets `wh_first_touch` **only when `wh_consent=granted` is already present** (a
  returning, already-consented visitor arriving via a new marketing link — stays HttpOnly, server-set). The
  **first**-consent moment is handled client-side by the banner: on **Accept** it records consent and, in the
  same gesture, promotes the current URL's utm to `wh_first_touch`; on **Reject** it records the denial and
  clears any first-touch cookie.
- **The banner:** a two-button client island (`consent-banner.tsx`) — **Accept** and **Reject**, one click
  each, same layer, equal prominence (reject as easy as accept). No granular category toggles: there is
  exactly one non-essential cookie, so categories would be theatre. Shows only when no `wh_consent` exists.
- **No storage before consent.** We do **not** buffer the utm in `sessionStorage` to promote it later. Cost:
  a visitor who navigates away from the landing URL *before* consenting loses attribution. Since the banner
  appears on the landing page where the utm is still in the URL, most consent there and lose nothing — and
  "no non-essential storage until consent" is the cleanest defensible reading of ePrivacy.
- **Legal basis:** the attribution cookie is now **consent** (Art 6(1)(a)); aggregate website analytics stay
  **cookieless** (Analytics Engine, no cookie) under legitimate interests — a genuinely separate mechanism.
  `/privacy` §3, §4 and §10 are updated to disclose the cookie, the banner, and the consent basis honestly.

All cookie *decisions* live in the pure, DOM-free `apps/www/src/lib/consent.ts` (`readConsent`,
`buildConsentCookie`, `consentWrites`), unit-tested exhaustively; the worker (`first-touch-capture.ts`) and
the banner both call into it, so the policy has one source of truth.

## Consequences

- **Attribution now works for OAuth**, and is robust to the app-bounce that broke the URL-param design.
- **A minority of consenting visitors lose attribution** (navigate before consenting). Acceptable, and honest.
- **The banner is user-facing UI** → human-UI verification is required before it ships (constitution hard
  stop). It is a `'use client'` island (www is a static export), an accessible labelled region, and themed via
  `--wh-*` tokens so it works in the dark default and light.
- **HttpOnly is mixed:** the worker path stays HttpOnly; the first-consent client path can't be (JS-set),
  which is fine — `wh_first_touch` holds non-sensitive utm data, and consent inherently requires JS anyway.
- The token-gated weekly-review endpoint and the reviewer role (ADR-0127 follow-up 2) are unaffected.

## Alternatives considered

- **Keep the cookieless URL-param approach.** Rejected: fragile three-hop propagation, and no OAuth
  attribution — the two problems above.
- **Set the cookie with disclosure only, no banner.** Rejected: a non-essential cookie needs ePrivacy
  consent, not just a privacy-policy line.
- **Granular consent categories / a full CMP.** Rejected as disproportionate: one first-party, PII-free
  attribution cookie does not warrant category toggles or a third-party consent platform.
