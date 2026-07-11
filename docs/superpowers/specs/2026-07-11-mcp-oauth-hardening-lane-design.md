# MCP OAuth hardening lane — design

- date: 2026-07-11
- scope: `apps/auth` (issuer, DCR/CIMD, consent), `apps/web` (connected apps), `packages/db` (grant schema),
  `apps/docs` (public docs)
- status: proposed → in implementation
- relates: ADR-0109 (loopback accepts localhost), ADR-0110 (no OIDC alias), PR #462 (the redirect-policy fix),
  the MCP authorization spec (2025-11-25 / draft), `draft-ietf-oauth-client-id-metadata-document-02`,
  RFC 9207, RFC 8252, RFC 9700

## Why this lane exists

PR #462 made OAuth work for every MCP client, but left five items on the backlog. The founder's direction
is to eliminate the backlog, not carry it. Research (four parallel Opus agents against primary sources +
the library source + shipped client binaries) turned up that the backlog was **wrong about two of the five**
and **missed two real defects**. This spec records what the work actually is.

## What the research changed

| Backlog item | Research verdict |
| --- | --- |
| "Serve `/.well-known/openid-configuration` (prod 404)" | **Do NOT build it.** Serving it would *break* clients. → ADR-0110 |
| "Advertise CIMD to lift the vendor allowlist" | Build it — but the naive one-line flag flip **reopens the phishing hole #462 closed**. Needs a redirect fence + consent UI. |
| "Apply IPv6 /64 to `edgeRateLimit`" | Real, plus **two more defects** in the same file (no CORS on the 429; `/device/verify` ungated entirely). |
| "Dashboard connected-apps + revoke" | Blocked on schema: **`auth_grant` has no `client_id`**. Needs a migration. |
| "Consent screen provenance" | Promoted from *nice-to-have* to a **MUST-level prerequisite for CIMD**. |
| — (not on the backlog) | **RFC 9207 `iss` is missing entirely** — no mix-up-attack defense. |

### OIDC discovery: the 404 is correct (ADR-0110)

Our issuer has no path component, so a conformant client builds exactly two discovery URLs, tries
`/.well-known/oauth-authorization-server` **first**, gets a 200, and never requests the OIDC one. The MCP
spec requires an AS to serve *at least one* of RFC 8414 or OIDC Discovery — we serve 8414.

Serving an alias is actively harmful: the official TS SDK selects its parser from *which URL answered*, and
its OIDC schema hard-requires `jwks_uri`, `subject_types_supported`, `id_token_signing_alg_values_supported`.
We are an opaque-token AS with no JWKS. An honest alias fails that schema, and the resulting parse error is
**not** caught by the 404-fallback path — it aborts the whole auth flow. A benign 404 would become a hard
failure. Cloudflare's own MCP servers, Sentry, and Notion all 404 this path in production.

### CIMD: the flag flip is a trap

`@cloudflare/workers-oauth-provider@0.8.1` already implements CIMD (`clientIdMetadataDocumentEnabled`), and
we already carry the required `global_fetch_strictly_public` SSRF compat flag. The library handles the fetch,
a 5 KB cap, a 10 s timeout, `client_id`-matches-URL, and auth-method fencing.

**But the CIMD path never calls `clientRegistrationCallback`** — that only fires on DCR `/register`. So our
entire vendor-allowlist redirect policy (`dcr.ts`) is **bypassed** on the CIMD path: the provider takes
`redirect_uris` straight from the fetched document. Enabling CIMD naked therefore reopens exactly the
consent-phishing vector #462 closed — an attacker hosts `https://evil.com/c.json` with
`{"client_name": "webhook.co official", "redirect_uris": ["https://evil.com/cb"]}` and phishes a logged-in
user through consent.

CIMD proves the **client_id** domain. It does **not** prove the **redirect** domain — the IETF draft
explicitly leaves same-origin as a `MAY`, not a `MUST`.

**Who actually does CIMD today** (from shipped binaries/source, not marketing):

| Client | Mechanism | Metadata doc | redirect_uris |
| --- | --- | --- | --- |
| Claude Code | **CIMD** | `claude.ai/oauth/claude-code-client-metadata` | portless loopback |
| VS Code / Copilot | **CIMD** | `vscode.dev/oauth/client-metadata.json` | loopback + `https://vscode.dev/redirect` |
| Zed | **CIMD** | `zed.dev/oauth/client-metadata.json` | portless loopback |
| Claude Desktop, Cursor, Codex, Cline, Continue | DCR | — | — |
| Windsurf | unknown (closed, no artifact) | — | bearer |

All three CIMD clients gate on our advertised flag, so flipping it **moves them off DCR onto CIMD**. That is
a real behavior change. All three retain a DCR fallback, so the DCR clients are unaffected.

## The decisions

### D1 — CIMD trust policy: open any-https CIMD + origin-honest consent + a redirect fence (FOUNDER DECISION 2026-07-11)

Accept **any** https `client_id` URL (no domain allowlist — the point of CIMD), gated by the full mitigation
package below. This was a deliberate founder risk-decision after a devil's-advocate pass and a SaaS-prior-art
study; the conservative alternative (allowlist for v1) was on the table and declined in favour of true
self-onboarding done the way the mature industry does it.

**Honest accounting of what each control does — the earlier draft of this doc overclaimed and is corrected
here:**

- The **same-origin-or-loopback redirect fence** (requested `redirect_uri` MUST be http loopback, any port,
  OR https same-origin with the `client_id` URL; own origins rejected) does **NOT** close consent-phishing.
  An attacker who owns `evil.com` hosts both the doc and the redirect on `evil.com` — same-origin, fence
  passes, code lands on their server. What the fence *does* stop is **code interception/redirection to a
  third origin**: the code can only ever reach the origin the consent screen names, or the user's own
  loopback. It makes the consent decision *coherent*; it is not itself the anti-phishing control.
- The **anti-phishing control is the origin-honest consent screen** (D3) plus **revocation** (slice 5). This
  is exactly the posture of Google / Microsoft / GitHub / Bluesky / WorkOS: render the un-spoofable origin,
  never the attacker-supplied name/logo, make Deny dominant, and give the user a one-click kill switch.

This does **downgrade** one thing versus today: currently `evil.com` cannot register a remote-https redirect
at all (a flat 400 at DCR). Open CIMD lets `evil.com` run a consent-phishing flow against a user for access
to *that user's own* account — the standard illicit-consent-grant risk every OAuth provider carries. The
founder accepted this in exchange for open onboarding, conditioned on the full package shipping.

**Zero client coverage cost** (verified against the live metadata docs, 2026-07-11): Claude Code (loopback),
Zed (loopback), VS Code (loopback + `vscode.dev/redirect`, same-origin with its `vscode.dev` doc) all pass
the fence unchanged.

**Required mitigation package (all MUST ship; the flag flip is gated on them):**
1. Origin-honest consent screen — D3 (human-UI hard stop).
2. Same-origin-or-loopback redirect fence in `/authorize` (the library's DCR callback never runs on the CIMD
   path, so this is our gate).
3. Pre-auth **CIMD-fetch throttle + negative-cache**: `parseAuthRequest` fetches the `client_id` URL BEFORE
   the session check, so an unauthenticated caller can make us fetch arbitrary public URLs (a reflector).
   Throttle per source IP, cap distinct `client_id` hosts per IP, negative-cache hosts that don't return a
   valid doc.
4. **Short grant TTL for non-first-party clients** (below the 90d first-party ceiling).
5. **Staged/canary flag rollout** + synthetic monitors on the three vendor metadata URLs + structured logging
   that separates CIMD-fetch failure causes (vendor-down vs our-egress) + a runbook. The failure mode is an
   opaque 400 with no DCR fallback, and Claude Code is the #1 client.

**Accepted residual (unfixable from outside the library):** `@cloudflare/workers-oauth-provider@0.8.1`
follows HTTP redirects on the CIMD fetch (the IETF draft says MUST NOT). An open redirect on a *trusted*
domain (`trusted.com/r?url=evil.com/doc.json`) makes us fetch attacker metadata while the `client_id` origin
still reads as `trusted.com` — so the origin-honest headline can be borrowed. Filed upstream; the redirect
fence still constrains where the code can be delivered. Revisit if the library adds `redirect: 'manual'`.

### D2 — DCR stays as-is, and stays allowlisted

DCR is deprecated by the spec but is still what Claude Desktop, Cursor, Codex, Cline and Continue use. We
keep it, we keep its vendor https allowlist, and we do **not** widen it. New clients should arrive via CIMD.

### D3 — the consent screen is a prerequisite, not a follow-on

The MCP spec's CIMD security section is normative and blunt: an AS **MUST clearly display the redirect URI
hostname**, and **SHOULD display additional warnings for `localhost`-only redirect URIs**. It also states
that CIMD *cannot* prevent localhost impersonation by itself.

Independent of CIMD, we already have a live weakness: **`client_name` is entirely attacker-controlled** —
`validateClientRegistration` validates only `redirect_uris` — and it is rendered as the consent **headline**.
A DCR client can register as "webhook.co Official" and the screen says `Authorize webhook.co Official`, with
no redirect host shown and no verification badge.

So the consent screen must show, for every client: the app name, **the client's identity domain** (the CIMD
host, or the client_id for a DCR client), **the redirect hostname**, the scopes in plain language, and an
**"unverified app"** treatment for anything that isn't first-party.

**This is a human-UI hard stop.** Per the engineering guardrails it cannot be self-certified — the founder
must eyeball it before merge. CIMD does not go live until it lands.

### D4 — connected apps needs a migration

`auth_grant` records `device_name`, `auth_method`, `org_id`, `user_id` — but **not** the OAuth client. The
client identity is captured at consent and discarded when the provider grant is revoked post-mint (the
Option-B/G1 pattern). So "Connected apps: Claude, Cursor" is not renderable today.

Add `client_id` + `client_name` to `auth_grant`, thread them through `ConsentProps` → the mint, and build the
dashboard surface on the **existing** pattern (server component + server action + `@webhook-co/db` over
`HYPERDRIVE_TENANT`). No new auth↔web binding needed. Revoke already exists (`revokeGrantById` → cascade +
`KV_AUTHZ` evict); it just needs the client identity to display against.

### D4b — never render `logo_uri` on the consent screen

The three live CIMD documents were fetched and inspected. Two of them (VS Code, Zed) ship a `logo_uri`
pointing at an external CDN. The consent screen does **not** render a client logo today and **must not
start**: `logo_uri` is attacker-controlled for any self-registering client, so rendering it hands an attacker
(a) a brand-spoofing surface directly above our own "Authorize" button — the one place a user is deciding
whom to trust — and (b) a tracking pixel that fires on our origin, leaking that a specific user is mid-grant.

The client's *identity domain* (text, ours to render, derived from the `client_id` URL) is the trustworthy
signal. An image the client supplies is not. Same reasoning excludes `client_uri` as a clickable link.

### D5 — RFC 9207 `iss` (not on the backlog; ship it)

We emit no `iss` on authorization responses, so a client cannot detect an AS mix-up attack — an attacker
who controls one AS the client talks to can induce it to send an honest AS's code to the attacker's token
endpoint. PKCE does **not** prevent this (the client hands its verifier to the attacker's endpoint itself).

Emit `iss` on **every** authorization response, success and error, and advertise
`authorization_response_iss_parameter_supported: true`. The two ship together: RFC 9207 says a client that
sees the flag but no `iss` **MUST reject** the response, so shipping one without the other breaks the very
clients it protects. The provider has no hook for either, so we stamp the redirect in `consent-core` and
merge the advertisement into the provider's metadata response in `worker.ts`.

## Slices

| # | Slice | Ships | Gate |
| --- | --- | --- | --- |
| 1 | Shared IP throttle: `/64` bucketing, CORS on the 429, gate `/device/verify` | `ip-throttle.ts`; `edge-rate-limit` + `register-guard` rewritten onto it | self-merge |
| 2 | OIDC: prove not needed | ADR-0110 + discovery-contract lock tests | self-merge |
| 7 | RFC 9207 `iss` + advertisement | `iss-param.ts`, `as-metadata.ts`, `consent-core` | self-merge |
| 4 | Consent provenance: identity domain, redirect host, unverified badge, localhost warning | `consent-form.tsx`, `ConsentRequestSchema`, ticket payload, `consent-core` | **human UI verify** |
| 3 | CIMD: enable + same-origin/loopback redirect fence | `oauth-config.ts`, `dcr.ts` (`isCimdClientId`, `isCimdRedirectAllowed`), `/authorize` gate | self-merge (after 4) |
| 5 | Connected apps + revoke | migration (`auth_grant.client_id`/`client_name`), `ConsentProps`, dashboard page | **human UI verify** |
| 6 | Public docs | `apps/docs` — client/auth matrix, OAuth details, troubleshooting, changelog | self-merge |

Slices 1, 2 and 7 are independent and ship first. Slice 4 **must** precede slice 3 going live.

## Testing

TDD throughout (red → green → refactor), per the repo's iron law. Pure cores are tested first; the workerd/
DO shells are thin glue tested after.

- `ip-throttle`: IPv6 `/64` collapse (a rotating low-64 attacker is caught), IPv4-mapped handling, CORS echo
  present with an Origin and absent without, fail-open on unbound KV / absent IP / KV fault.
- `iss-param`: `iss` on success and on **error** redirects; a relative device-status location left untouched;
  a client-smuggled `?iss=` **overwritten**, not appended.
- `as-metadata`: advertisement merged; other paths untouched; non-200 and non-JSON pass through; the
  provider's CORS survives.
- `dcr`: the CIMD fence — same-origin https accepted, loopback accepted, cross-origin https **rejected**, own
  origins rejected; the three real client shapes (Claude Code, Zed, VS Code) accepted verbatim.
- `consent-core`: the redirect host + identity domain are sealed into the ticket and cannot be forged.
- Full gate + `/code-review` + `/security-review` before every merge.

## Explicit non-goals

- Becoming an OIDC provider (id_token/JWKS/userinfo). Not an MCP requirement; a separate product decision.
- A publisher-verification program (submit-and-review). The unverified-app treatment is the v1; a verified
  tier can come later if third-party clients become a real surface.
- Org-admin app-approval policies ("only allow apps I've approved"). Table stakes for enterprise IdPs, but
  premature here — revisit when we have enterprise orgs asking.
