# ADR 0052 — loopback consent completion: a same-origin bounce + server 302

- status: accepted
- date: 2026-06-22
- scope: `apps/auth/src/issuer/completion-ticket.ts` (new) + `authorize-route.ts`
  (`handleConsentDecision` bounce + `handleConsentComplete`) + `authorize-deps.ts`
  (`sealLoopbackRedirect`/`openLoopbackRedirect`) + `issuer-handler.ts` (the `GET /consent/complete`
  intercept). No client (Lane E) change; no migration.
- relates: ADR-0030 (the consent→mint flow this extends), ADR-0026 (loopback redirect policy), RFC 8252
  (native-app loopback), `internal/build-plans/lane-c-auth-identity-backend.md`.
- review: 1 adversarial security review (open-redirect / shared-key / replay / header-injection) — clean,
  no BLOCKER/MAJOR.

## Context

The CLI's `wbhk login` is an RFC 8252 native app: it runs a `http://127.0.0.1:<port>/callback` loopback
server and opens the browser at `/authorize`. After the user approves consent, the browser must reach that
loopback URL carrying the auth code. Our consent flow recorded the decision via a `fetch` to
`/consent/decision` that returned JSON `{redirectTo}`, and the consent client then did
`window.location.assign(redirectTo)`. For the loopback case that is a **script-initiated, top-level
navigation from a public HTTPS origin (auth.webhook.co) to a local HTTP address (127.0.0.1)** — which
Chrome's **Private Network Access** blocks. The browser stayed on auth.webhook.co, the CLI never received
its callback, and `wbhk login` hung. (Confirmed in a live e2e.)

## Decision

Convert the blocked *client-side cross-origin* navigation into a *same-origin client navigation + a
**server-side 302***, the canonical native-app pattern (what `gh`/`gcloud`/`aws` rely on):

- `handleConsentDecision`, when the decision's `redirectTo` is **absolute** (the loopback callback —
  approve *or* deny), seals it into a **same-origin** `/consent/complete?c=<ticket>` and returns *that* as
  `{redirectTo}`. A **relative** target (the device flow's `/device?status=…`) is returned unchanged.
- The consent client is **unchanged** — `window.location.assign` now targets the same-origin bounce path,
  which the browser always allows.
- A new unauthenticated `GET /consent/complete` verifies the ticket and issues a **302** to the loopback;
  browsers follow a top-level 302 to a `127.0.0.1`/`::1` literal.

**The completion ticket** (`completion-ticket.ts`) is an HMAC-signed, 120s `{t:"loopback_complete",
redirectTo, exp}`, sealed with the existing `CONSENT_TICKET_KEY` (a fixed type tag domain-separates it from
the consent ticket that shares the key). It seals the server-computed, already-loopback-validated URL so
`/consent/complete` can never be an open redirector; `openLoopbackRedirect` additionally **re-asserts the
URL is an http loopback literal** (`isAllowedRedirectUri`) before the 302 — defense in depth.

## Why not the alternatives

- **Native HTML form POST → 302 directly from `/consent/decision`:** also works, but requires Lane E to
  rewrite the consent form away from the fetch client, relax the `application/json` CSRF gate to accept
  form-encoding, and render errors in a top-level-nav context — a cross-lane change while Lane E is
  actively building the consent page. The bounce is entirely server-side (Lane C), backward-compatible, and
  leaves the device flow untouched.

## Consequences

- One extra same-origin hop per loopback login (negligible). The auth code transits the bounce ticket then
  the 302 `Location` — no new exposure (it was already destined for that loopback URL) and PKCE +
  provider-enforced single-use keep a replayed/spent code useless.
- **Needs human/CLI e2e to confirm** the PNA block is resolved (`wbhk login` completes) — server logic is
  unit-tested but the browser behavior can't be verified in CI.
- Follow-up (optional, from review): add a symmetric type tag to the consent ticket so the
  completion↔consent domain separation is enforced upfront in both verifiers (currently the completion→
  consent direction is covered by downstream field checks).
