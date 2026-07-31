# Legal basis — Google Identity Services (One Tap) on `auth.webhook.co/login`

- status: **recorded, pending counsel ratification**
- decided: 2026-07-31 (founder)
- decision: **do not gate GSI behind a consent banner; record a written basis instead**
- owner: founder
- relates: [ADR-0133](adr/0133-google-one-tap.md) (the feature),
  [ADR-0128](adr/0128-first-touch-consent-cookie.md) (the consent position this must be squared with),
  `/privacy`, `/sub-processors`

> **This is an engineering record, not legal advice.** It exists so that counsel can ratify, amend or
> reject a position on the basis of accurately measured facts rather than assumptions. Every factual
> claim in §1 was measured against production, not read from documentation. If counsel disagrees with
> §2, the mitigation is already specified in §7 and is a small change.

## 1. What actually happens — measured, not assumed

Measured on production `auth.webhook.co/login` with a fresh browser profile, **signed out of Google**,
and with **no interaction of any kind** (no click, no dismissal), in two engines: Chrome with FedCM
(the modern path) and Chrome with FedCM disabled (the legacy path Safari and Firefox take).

| | Chrome (FedCM) | Legacy / Safari-Firefox path |
| --- | --- | --- |
| Requests to `accounts.google.com` | `/gsi/client`, `/gsi/style`, `/gsi/fedcm.json`, `/gsi/fedcm/listaccounts` | `/gsi/client`, `/gsi/style`, `/gsi/status` |
| Storage written | `g_state` cookie | `g_state` cookie |
| `localStorage` / `sessionStorage` | empty | empty |

`g_state` attributes, as set:

| attribute | value |
| --- | --- |
| scope | **first-party**, `Domain=auth.webhook.co`, `Path=/` |
| lifetime | **180 days** (persistent) |
| `HttpOnly` | **false** (readable by page JavaScript) |
| `Secure` | **false** (transmitted over TLS regardless — the host is HSTS-only, `max-age=63072000`) |
| `SameSite` | `Lax` |
| contents | a JSON blob: two timestamps, a counter, a feature flag, and `i_b` — an **opaque identifier-like token** |

**Three facts follow, and each one matters:**

1. **Storage happens before any interaction.** It is not set on dismissal; it is set on load. So the
   ePrivacy storage rule is engaged and cannot be argued away as "no storage occurs".
2. **It is first-party and scoped to our host.** The browser will never send it to `accounts.google.com`.
   It is not a cross-site tracking cookie, and Google's servers cannot read it directly. We have **not**
   independently verified whether the GSI script transmits its contents in the `/gsi/status` or
   `/gsi/fedcm/listaccounts` calls; that is a limit of this assessment, recorded in §6.
3. **Every visitor to the login page is affected**, including one who never uses Google — the script
   loads before any choice, so the visitor's IP address and the referring URL reach Google regardless.

## 2. The analysis, in two limbs

These are genuinely separate rules and conflating them is the usual mistake. ePrivacy governs **storing
or accessing information on the user's device**. GDPR governs **processing personal data**, which here
means the transmission of the IP address to Google. A basis for one is not a basis for the other.

### Limb A — ePrivacy Art. 5(3): the `g_state` cookie

Art. 5(3) requires prior consent for storage on terminal equipment, with one relevant exemption:
storage **strictly necessary** for providing an information society service **explicitly requested by
the user**.

**The position taken: the strictly-necessary exemption applies.** The reasoning, and it must be read
together with its weaknesses:

- **The service explicitly requested is authentication.** The user navigated to a URL whose sole
  function is signing in. This is not a content page with an authentication widget attached; the page
  has no other purpose. One Tap is a means of performing the very service requested.
- **`g_state` exists to suppress, not to track.** Its documented function is One Tap's cool-down state —
  it records that the prompt has been shown so it is not shown again, and backs off further on
  dismissal. Its effect on the user is *less* intrusion, not more.
- **This is the principle this repo has already adopted.** ADR-0128 holds that `wh_consent`, which
  records a visitor's choice about a banner, "is itself strictly-necessary, so this cookie needs no
  consent." A cookie whose purpose is to remember "do not show this again" is the same character of
  thing. Applying that principle here is consistent, not opportunistic.
- **No advertising or cross-site use.** First-party, unreadable by Google's servers, and not used for
  profiling or ad targeting by us.

**The weaknesses, stated plainly rather than buried:**

- **One Tap is not necessary for the requested service.** ADR-0133 itself calls it "an enhancement
  layered on a page that already works without it", and the page offers three other working sign-in
  methods. That is the standard argument *against* strict necessity, and it is a fair one.
- **It is set before there is any choice to remember.** The suppression rationale is strongest for a
  cookie written *on dismissal*. This one is written on load, carrying an opaque `i_b` value whose
  purpose we have not verified.
- **180 days is long** for "remember that we showed a prompt", and we cannot shorten it — the lifetime
  is Google's choice, not a parameter we set.
- **ADR-0128 reached the opposite conclusion for a comparable cookie** and stated that "no non-essential
  storage until consent" is "the cleanest defensible reading of ePrivacy". This record does not overturn
  that reading; it asserts that `g_state` falls on the *other* side of the line because it serves the
  authentication the user came for, whereas `wh_first_touch` served marketing attribution the visitor
  neither asked for nor benefits from. **A reviewer who thinks that distinction is too fine is making a
  reasonable objection**, and §7 is the answer if they are right.

### Limb B — GDPR Art. 6: disclosing the IP address to Google

Loading `accounts.google.com/gsi/client` discloses the visitor's IP address and the referring URL to
Google on every login-page view, before any interaction. That is processing of personal data and needs
an Art. 6 basis.

**Basis relied on: Art. 6(1)(f), legitimate interests.** Assessment:

- **Purpose test.** The interest is offering a faster, phishing-resistant sign-in on our authentication
  page, and reducing credential-based account compromise. That is a legitimate business interest, and
  security of processing is expressly recognised as one (Recital 49).
- **Necessity test.** One Tap cannot function without loading Google's script, and the script cannot be
  loaded without disclosing an IP address. Deferring the load until the user chooses Google would work,
  but would defeat the feature — the prompt exists precisely to be offered before the user picks a
  method. There is no less intrusive way to achieve *this* purpose. (It is a fair counter that the
  *purpose itself* is optional; that is the Limb A objection restated, and it is answered the same way.)
- **Balancing test.** Weighing against the visitor:
  - the data is an IP address and a referring URL — the same pair disclosed to Cloudflare Turnstile,
    which already loads on this page under the same reasoning;
  - the recipient is a major processor operating under its own published terms, already engaged as a
    sub-processor for exactly this purpose (Google sign-in) and disclosed as such;
  - the context is a login page, where a reasonable user *expects* identity providers to be involved;
  - no profiling, no advertising, no automated decision-making, and nothing is combined with other data
    by us;
  - it is disclosed prominently and specifically in `/privacy` and `/sub-processors` (§4).

  The residual impact is low and the visitor's reasonable expectations are met. **Balance favours
  processing**, and this is recorded as a decision made with the counter-arguments in view.

**Alternative reading available if counsel prefers it:** Art. 6(1)(b), steps taken at the data subject's
request prior to entering into a contract — the visitor is on a sign-in page for that express purpose.
This record relies on 6(1)(f) because the script loads *before* the visitor has requested anything
specific, which makes 6(1)(b) a stretch at the moment of loading.

## 3. Transfers

Google LLC processes in the **United States**. Covered by Google's own transfer mechanism (EU-US Data
Privacy Framework certification and/or SCCs, per Google's terms). Google LLC is already listed on
`/sub-processors` with "United States" as the location, entered for Google sign-in before One Tap
existed. No new transfer, no new recipient — a wider trigger for an existing one.

## 4. Transparency — what we tell people, and where

Transparency is load-bearing in the balancing test above, so it is not optional decoration:

- **`/privacy`** states that the login page loads Google Identity Services, that it loads **on every
  visit before the visitor chooses a sign-in method**, that Google can therefore see their IP address
  and that they opened the page, and that **nobody is signed in without tapping to confirm**. It also
  names the `g_state` cookie, its purpose and its lifetime.
- **`/sub-processors`** lists Google LLC for both "Sign in with Google" and Google Identity Services,
  and states the same before-any-choice fact.

Both were corrected in the same change that shipped One Tap, specifically because the previous copy
("only if you choose Google to sign in") became false the moment it shipped.

## 5. What the visitor can do

- **Use any of the three other sign-in methods.** The page is fully functional without ever interacting
  with the prompt, and dismissing it is silent and permanent for the cool-down period.
- **Delete the cookie.** `g_state` is first-party and not `HttpOnly`, so ordinary browser controls and
  extensions remove or block it, and blocking `accounts.google.com` degrades the page gracefully to its
  pre-One-Tap behaviour (verified — a blocked script produces a console warning only, never a user-facing
  error).
- **Object under Art. 21**, as with any 6(1)(f) processing, via the contact route in `/privacy`.

## 6. Limits of this assessment

Stated so that nobody mistakes it for more than it is:

- We have not verified whether the GSI script transmits `g_state`'s contents back to Google in
  `/gsi/status` or `/gsi/fedcm/listaccounts`. If it does, the "Google's servers cannot read it" point in
  §1 weakens — though the IP disclosure it would accompany is already accounted for in Limb B.
- We do not control `g_state`'s name, contents, lifetime or attributes; Google may change any of them
  without notice, and nothing in CI would detect it.
- No Data Protection Impact Assessment has been carried out. On this analysis none is required — no
  large-scale special-category data, no systematic monitoring, no profiling — but that conclusion has
  not been reviewed by counsel.
- **No lawyer has reviewed this document.** It is the engineering record that a review would start from.

## 7. If this position is rejected

The mitigation is small and specified in advance, so that rejecting the position costs a change rather
than an argument:

`apps/auth/src/app/(auth)/login/login-actions.tsx` renders `<OneTap>` behind a single condition. Gating
it on a consent signal means not rendering that component until consent exists — no change to the server
plugin, the CSP, or any other sign-in method, and the page keeps working exactly as it does today for a
visitor who has not consented. The cost is that One Tap would be unavailable to a first-time EU visitor
until they interact with a banner, which is most of its value on that visit.

`apps/www` already has the consent primitives (`lib/consent.ts`, `consent-banner.tsx`), but they are on
a **different registrable apex** and the `wh_consent` cookie is `Domain=.webhook.co`, so
`auth.webhook.co` can read it. That is the seam to use; it was not used here because the decision was to
record a basis instead.

## 8. Re-review triggers

Re-open this record if any of these change:

- Google alters `g_state`'s purpose, lifetime, or contents, or begins using it for anything beyond
  prompt suppression.
- One Tap is placed on any page whose primary purpose is **not** authentication. The whole Limb A
  argument depends on that.
- `autoSelect` is ever enabled, or the prompt becomes capable of signing someone in without a tap. That
  would change the character of the processing entirely.
- A supervisory authority or the EDPB issues guidance on federated-identity prompts and Art. 5(3).
- We add a consent mechanism to `auth.webhook.co` for any other reason — at which point gating this
  becomes nearly free and the balance shifts.
