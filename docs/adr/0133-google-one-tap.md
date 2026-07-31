# ADR 0133 — Google One Tap on the login page

- status: accepted
- date: 2026-07-31
- scope: `apps/auth` (the login page on auth.webhook.co), `apps/www` (privacy + sub-processors copy)
- relates: [ADR-0056](0056-auth-csp.md) (the auth CSP — amended in place by this ADR);
  [ADR-0044](0044-turnstile-magic-link-captcha.md) (the Turnstile captcha, the other third party on this
  page); [ADR-0027](0027-magic-link-durable-rate-limit.md) (why a per-isolate limiter is not a limiter)

## context

A returning visitor with a live Google session had to click "Continue with Google" and take a redirect
round-trip through Google's account chooser. One Tap replaces that with a prompt on our own page.

Three things found during research shaped the scope more than the feature itself did.

**One Tap DEGRADES profile data.** better-auth's one-tap plugin builds its user record by hand from the ID
token, destructuring only `{email, email_verified, name, picture, sub}`, and hands `handleOAuthUserInfo` an
empty provider profile. So `socialProviders.google.mapProfileToUser` — which maps `given_name`/`family_name`
onto our columns and which `runtime/auth.ts` calls load-bearing — is NEVER CALLED on this path. Shipped
naively, a One Tap signup lands with both name columns NULL: strictly worse data than the button it
replaces.

**The login page had zero browser coverage.** It is the single door into the product — the issuer bounces
unauthenticated `/authorize` here and app.'s session handoff bounces here — and nothing in CI had ever
opened it in a browser. The jsdom suite injects a fake captcha precisely so Cloudflare's script never
loads, and `build-cf` only compiles. Adding a second third-party script to that page would have meant the
first real-browser run of the new CSP happened in production.

**The plugin's browser half is not fit to call unsupervised.** Read end to end at 1.6.25: a module-level
`isRequestInProgress` flag that can stick true forever under FedCM (killing One Tap for the rest of the JS
context), a 31-second exponential retry ladder of timers nothing cancels, no `cancel()`, and a script
loader that leaks a dead `<script>` on failure.

## decision

**Ship One Tap on `/login` only, prompt-plus-tap-to-confirm, never silent.** `auto_select: false`. Signups
allowed. Placement stays on the auth surface so the host-only cookie design and the existing
`/session/handoff` are untouched.

**Resolve the client id from the Secrets Store binding; commit nothing.** The obvious alternative — a
committed public constant — was rejected on three grounds. This repo is public and open-core, so a
hardcoded id bakes *our* audience into every self-hoster's build, failing as `unregistered_origin`
(console-only, no user-visible signal). The `no-secrets` rule forbids committing cloud account identifiers,
and the numeric prefix of a Google client id is the GCP project number. And a committed constant is a
second source of truth for the audience, which then needs a drift detector to police the two; reading the
one binding that already keys verification makes the drift **unrepresentable** rather than merely
detectable.

**Gate the endpoint on the same predicate as the prompt.** `oneTap()` is mounted only when Google is fully
configured AND the resolved id passes a shape check (`isGoogleClientId`) — the identical check the browser
gate uses. One predicate over one secret means the prompt and the endpoint cannot drift into "prompt with
no endpoint" or "endpoint with no UI that can reach it". The shape check also converts a plausible deploy
fault — `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are adjacent lines in every config file here — from
"the client secret renders into a public page's HTML" into "One Tap quietly does not appear".

**Pin the audience explicitly** from the resolved secret rather than riding the plugin's implicit
`googleProvider?.clientId` fallback. Both resolve to the same value today; stating it is what makes "an ID
token minted for another Google app is useless here" survive a refactor of the social-provider map.

**Own the browser lifecycle; use better-auth only for the server endpoint.** The endpoint contract is one
POST and a contract test pins it against a real instance, so owning the client half costs no coverage and
buys a lifecycle that can be reasoned about: one prompt per mount, `cancel()` on unmount, no stray timers,
a script loader that resets and removes the dead tag on failure.

**Repair the profile damage in a `create.before` hook.** Exact `given_name`/`family_name` from the
already-verified token when the path proves it is the One Tap callback, `splitName` otherwise, and
**fill-only-when-absent** so the OAuth-button path stays a strict no-op. Decoding without re-verifying is
sound because the plugin's handler is strictly sequential: `verifyGoogleIdToken` throws before
`handleOAuthUserInfo`, the only route to this hook. An email cross-check turns that proof into a proof plus
a guard for the cost of one string compare.

**Meter the callback at the edge.** `POST /api/auth/one-tap/callback` is public and unauthenticated, and on
any well-formed JWT header it calls Google's certs endpoint through an uncached `betterFetch`. better-auth's
own limiter for it is the generic 100-req/10s, which is in-memory and per-isolate and therefore does
nothing fleet-wide — the same reasoning as ADR-0027. It joins the existing durable edge throttle at
30/60s per IP.

**Emit sign-in method telemetry.** One Tap and the Google button write identical rows (same `providerId`,
same `sub`), so without this the feature is unfalsifiable — impossible to justify or retire on evidence.

### CSP: how each directive was derived

Google's documentation says changes are needed without naming values, so the set was determined
empirically: the login page was run in four engines — Chrome with FedCM, Chrome with FedCM force-disabled,
Firefox, and Safari/WebKit — recording the resource type of every request reaching `accounts.google.com`.
Iterating on violations alone is insufficient, because the first block stops everything downstream, so each
pass reveals only the next directive.

| Directive | Basis | Evidence |
| --- | --- | --- |
| `script-src` | proven | `GET /gsi/client`, all four engines. Blocked first. |
| `style-src` | proven | `GET /gsi/style`. GSI loads an **external** stylesheet; `'unsafe-inline'` does not cover it. The one usually missed. |
| `connect-src` | proven | `/gsi/fedcm.json` and `/gsi/log`. `other`-type under FedCM, XHR in the three non-FedCM engines. |
| `frame-src` | documented behaviour, **not** an observed request | See the limitation below. |
| `img-src` | deliberately NOT widened | The avatar is browser chrome (FedCM) or content inside a cross-origin iframe (legacy). Neither is governed by this page's CSP. |

**The limitation, recorded rather than glossed.** No engine requested an iframe — but every run had no
Google account signed in (`"Provider's accounts list is empty"`), so the prompt never rendered in any of
them. The experiment could only ever show what LOADING and INITIALIZING cost, never what DISPLAYING costs.
Google's legacy non-FedCM One Tap renders in an `accounts.google.com` iframe, and neither Safari nor Firefox
has FedCM, so dropping `frame-src` would break the prompt for exactly those users, visibly only to someone
with a live Google session. It is kept, and confirming it is on the human-verification checklist.

`Permissions-Policy` gains `identity-credentials-get=(self)`, which gates the FedCM prompt. It already
defaults to `self` for a top-level document, so nothing changes today — it is pinned so a future tightening
cannot silently disable One Tap with no failing test.

## amendment 2026-07-31 — an unverified provider email could create an account

Human verification passed on iPhone/Safari, desktop Chrome and desktop Safari, which also settles the
open `frame-src` question: Safari has no FedCM, so it took the legacy `accounts.google.com` iframe path
and the prompt rendered. That directive is necessary and sufficient, now on evidence rather than on
documentation.

An adversarial pass then found what two prior reviews did not. better-auth enforces a provider's
`emailVerified` **only when LINKING to an existing user** — the check sits inside `if (dbUser)` in
`oauth2/link-account.mjs`. The signup branch a few lines below calls
`createOAuthUser({ …, emailVerified: userInfo.emailVerified })` with no check at all. So
`accountLinking.requireLocalEmailVerified` and an empty `trustedProviders`, both of which this app sets
and both of which are correct, govern linking and say nothing about creation.

The chain: an attacker holding a Google account for `victim@company.com` that Google reports as
`email_verified: false` taps One Tap; a row for that address is created with the attacker's `sub` linked.
The victim later signs in by magic link, and `revokeUnprovenAccountAccess` deletes only
`providerId === "credential"` accounts — this app has none — so the attacker's Google link survives,
`emailVerified` flips to true, and the attacker keeps permanent access to the victim's account and org.

This predates One Tap; the Google button reaches the same code. One Tap removes the remaining speed
bumps, making it a single unauthenticated POST with no redirect and no captcha.

**Closed by `runtime/unverified-email-hooks.ts`**, a `user.create.before` that returns `false` — 
better-auth's abort signal — for any row whose `emailVerified` is not literally `true`. It is composed
outside the name back-fill, so a row that must not exist is never processed further. Verified against
the installed package that this breaks nothing: magic link creates with a literal `emailVerified: true`,
Google and One Tap pass the real claim, GitHub resolves `verified` from its email API, and nothing in
this repo creates users outside better-auth. Accepted cost: a GitHub signup whose email API call fails
resolves to `false` upstream and is refused rather than admitted — the correct direction, and magic link
remains available. Proven end to end by a contract test that signs a real token with
`email_verified: false` and asserts no user, no account and no session result.

## accepted risks

- **ID-token replay inside the 1h window.** `verifyGoogleIdToken` enforces issuer, audience, signature,
  `exp` and `maxTokenAge: 1h`. There is no nonce binding, and adding one would be theatre: the plugin
  accepts a `nonce` and forwards it to Google, but the server endpoint calls `verifyGoogleIdToken` WITHOUT
  it, so nothing verifies it. A stolen token is therefore replayable until it ages out. Bounded by TLS, by
  the token never being persisted (the account-token stripping hook nulls `idToken` on write), and by the
  edge throttle. Accepted; revisit if better-auth starts verifying the nonce.
- **No captcha on the callback**, unlike the magic-link send. Considered and declined: a garbage captcha
  token would only trade a Google-certs fetch for a Cloudflare siteverify fetch, the page renders one
  Turnstile widget whose single-use token the magic-link submit already consumes, and magic-link's actual
  justification — it emails an attacker-chosen third party — does not transfer. Reversing this is a
  one-line change to the captcha `endpoints` array.
- **The Better Auth drift guard cannot see this.** It reads only `apps/auth/src/auth.ts`, the generator
  config, and `oneTap()` is wired in the runtime config. Covered instead by a test asserting the plugin
  contributes no `schema` key — so it needs no migration, and if an upstream version starts declaring one,
  that test fails and says a migration is now required.
- **A second mount in one JS context.** Our wrapper prompts once per mount, so the plugin's stuck-flag
  hazard does not apply — but Google's own `cancel()`/prompt semantics on a client-side revisit to `/login`
  are on the human-verification checklist.
- **GSI loads before any consent, for EU visitors included.** `apps/www`'s consent banner states the house
  position that a non-essential cookie "may only be stored after consent" under ePrivacy, and One Tap is
  framed in this very ADR as an enhancement on a page that already works — which is the standard argument
  *against* the strictly-necessary exemption. GSI also sets a first-party `g_state` cookie to remember a
  dismissal. This is a legal-basis decision, not an engineering one, and it is **open**: either gate the
  script on `/login` behind consent, or record a written basis for treating it as exempt.

## consequences

- `accounts.google.com` is loaded by every visitor to `/login`, **before any choice is made**. The privacy
  policy and sub-processors page said Google was contacted "only if you choose Google to sign in", which
  this makes false; both are corrected in the same change.
- A contributor running their own Google OAuth app gets social sign-in and One Tap; one running
  `OAUTH_MODE=optional` gets neither, and no Google script loads at all. Recorded in `docs/local-parity.md`.
- **Ops prerequisite:** the OAuth client's **Authorized JavaScript origins** must contain
  `https://auth.webhook.co` (and `http://localhost:3001` for local dev). This is a DIFFERENT list from
  Authorized redirect URIs, and a missing entry fails as `unregistered_origin` — console-only, with no
  user-visible signal and no failing test.
