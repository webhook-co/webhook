# ADR-0120: Collapse the consent-screen scope list by default

- Status: accepted
- Date: 2026-07-16
- Supersedes the "consent stays verbose" stance of #612 (see below).

## Context

The OAuth consent screen (`auth.webhook.co/consent`, shown by `wbhk login`) rendered every requested scope
in full — a plain-English title + one-line description + the exact `resource:verb` machine scope, all
expanded. With the full capability set (8 scopes) plus the other summary rows (App, Identity, Sends-code-to,
Organization, Requesting-from, Authorized-until, Key-lifetime), the page is long enough to require scrolling.

**#612 deliberately kept this screen verbose.** Its rationale: the dashboard *review* surfaces (connected
apps, API keys, devices) may collapse scopes into an "N permissions" `<details>` because access is *already
granted* there — but the consent screen grants access, and hiding about-to-be-granted permissions behind a
click is a recognized consent dark pattern (it weakens informed consent and eases illicit-consent-grant
phishing). Google/GitHub/etc. show consent scopes expanded for exactly this reason.

The founder reviewed that trade-off explicitly (shown the dark-pattern framing) and chose to collapse the
consent scope list by default anyway, to shorten the screen.

## Decision

Render the consent Access row with the SAME `ScopeSummary` component the dashboard review surfaces use,
**collapsed by default**. This reverses #612's "consent stays verbose" decision, consciously, at the
founder's request.

Guardrails that make the collapse as safe as a collapse can be:

- **Nothing is hidden from assistive tech.** `ScopeSummary` is a native `<details>`: every permission's
  title, exact machine scope, and description stay in the DOM even while collapsed, and it is
  keyboard-accessible with one keystroke to expand. A screen-reader user reaches the full grant; only the
  default *sighted* view is condensed.
- **Honest face label.** The collapsed summary reads "N permissions — review before authorizing" (not a bare
  count), so it does not disguise that permissions are being granted.
- **The real anti-phishing levers are untouched.** For an unverified remote client the warning banner still
  shows and the Authorize button is still demoted below Deny; the org picker and identity/redirect rows are
  unchanged.

`ScopeSummary` was promoted from `apps/web` into `@webhook-co/ui` (presentational; `describeScope` injected)
so the consent screen and the review surfaces share one implementation and can't drift.

## Consequences

- Shorter consent screen (the founder's goal).
- Weaker *default-view* informed consent than the fully-expanded form — the documented trade-off. Revisit if
  consent-grant-phishing telemetry or a compliance review warrants re-expanding (flip the one call site back
  to the expanded `<ul>`, or default the `<details>` to `open`).
- This is a user-facing visual + consent-security change: it requires a human eyeball before it ships (per
  the repo's human-UI hard stop).
