# MCP OAuth + bearer for all clients — design

- date: 2026-07-11
- scope: `apps/auth` (OAuth issuer / DCR / consent), `apps/mcp` (resource server — bearer), docs
- status: proposed → in implementation
- relates: ADR-0026 (consent + deliberate-grant), ADR-0024 (token issuance), A3/A8 issuer lanes,
  the `@cloudflare/workers-oauth-provider` (v0.8.1) behavior

## Problem

Adding `mcp.webhook.co` to Claude Desktop (OAuth) fails with *"Couldn't register with Webhooks's
sign-in service"*; adding it to Claude Code fails with *"every redirect_uri must be an http loopback
(127.0.0.1 or ::1)"*. Reproduced against **production**:

- `POST /register` with `redirect_uris:["http://localhost:33333/callback"]` → `400 invalid_redirect_uri`
- `POST /register` with `redirect_uris:["https://claude.ai/api/mcp/auth_callback"]` → `400 invalid_redirect_uri`

## Root cause

Our Dynamic Client Registration policy callback (`apps/auth/src/issuer/dcr.ts`,
`isAllowedRedirectUri`) accepts **only** `http://127.0.0.1` and `http://[::1]`. It rejects `localhost`
(what Claude Code / VS Code / Continue use) and **all** `https` (what Claude Desktop and web clients
use). The v1 policy was written when the first-party CLI (which uses the `127.0.0.1` literal) was the
only OAuth client. The underlying provider already implements the spec-correct behavior
(RFC 8252 port-flexible loopback matching incl. `localhost` and `127.0.0.0/8`; exact-match otherwise);
our callback is the *only* thing narrowing it.

### Why tests didn't catch it

`apps/auth/src/issuer/dcr.test.ts` **asserts the broken policy** — it explicitly tests that `https`
and `localhost` are *rejected*. Green tests locked in the bug. No test exercises a real MCP-client
redirect shape. Fix: rewrite the tests around the spec-correct policy + real-client fixtures.

## Spec grounding (MCP authorization — 2025-03-26 / 2025-06-18 / 2025-11-25)

- Redirect URIs **MUST be either `localhost` or use HTTPS** (every revision). Custom URI schemes are
  not part of MCP. RFC 8252: the AS **MUST allow any port** on loopback and should accept
  `127.0.0.1`, `::1`, **and** `localhost`.
- DCR (RFC 7591) is the common denominator for the installed base (Claude, Cursor, VS Code, Codex,
  Cline, Zed, Continue). CIMD (2025-11-25) is the modern successor — roadmap, not required.
- Audience binding (RFC 8707) + PKCE-S256 + exact-match redirect: already satisfied.
- Bearer: a static `Authorization: Bearer <token>` is a legitimate, universal path. Our resource
  server already accepts a first-party `whk_` key **or** an opaque OAuth token (prefix-discriminated,
  `apps/mcp/src/resolve-bearer.ts`).

## Client coverage (research-derived)

| Client | Redirect the client uses | How we support it |
|---|---|---|
| Claude Code, VS Code, Codex, Cline, Zed, Continue | loopback `http://localhost`/`127.0.0.1[:port][/path]` | **Slice 1** loopback |
| Claude Desktop | `https://claude.ai/api/mcp/auth_callback` (+`claude.com`) | **Slice 2** allowlisted https |
| Cursor (web / cloud agents) | `https://www.cursor.com/agents/mcp/oauth/callback` | **Slice 2** allowlisted https |
| Windsurf | (redirect unconfirmed / closed source) | **bearer** (`whk_`) |
| Cursor (desktop) | `cursor://…` custom scheme (out-of-MCP-spec) | **bearer** (`whk_`) |
| any / future / self-hosted | — | **bearer** now; **CIMD** roadmap |

## Security posture (devil's-advocate-hardened)

Open DCR that accepts **arbitrary** `https` rests every org's write-scoped tokens on one click of a
consent screen (confused-deputy / consent-phishing — DA "R1"). We neutralize it structurally:

- **Loopback redirects carry no phishing surface** — the code can only reach the user's own machine
  and is PKCE-bound. Ship openly. Accepting `localhost` (required by Claude Code / VS Code / Continue)
  reverses the old IP-literal-only rule; the reasoning (browsers hard-map `localhost` to loopback per
  RFC 6761, PKCE binds the code, industry-standard) is recorded in **ADR-0109**.
- **Remote `https` is restricted to an allowlist of the known MCP-vendor callback hosts**
  (`claude.ai`, `claude.com`, `cursor.com`, `www.cursor.com`, `vscode.dev`, `insiders.vscode.dev`).
  An attacker therefore cannot register `https://evil.com` → R1's DCR path is eliminated, and this
  ships **without a consent-UI change** (no human-UI hard stop).
- **Own origins are rejected** (`webhook.co`/`*.webhook.co`, `wbhk.my`/`*.wbhk.my`) via exact
  `url.hostname` suffix-anchored match — no open-redirect-to-self, unit-tested against
  userinfo/punycode/suffix bypasses.
- **R3 (the sharp one):** the redirect predicate is reused by `openLoopbackRedirect`
  (`authorize-deps.ts:126`), which issues a **server 302**. Widening that shared predicate to `https`
  would make `/consent/complete` an own-origin **open redirector**. → **Split** the predicate:
  - `isRegisterableRedirectUri` (widened: loopback + allowlisted-https) — used by DCR + the two
    consent policy checks (`consent-core.ts:113,399`).
  - `isHttpLoopbackRedirect` (narrow: loopback only) — used by `openLoopbackRedirect` and by the
    completion branch to decide *bounce vs. direct nav*. Never bounce to non-loopback.
- **`/register` hardening (R2):** it has zero rate-limiting today (the "WAF covers it" comment is
  false). Add a pre-`provider.fetch` per-IP (IPv6 `/64`-bucketed, fail-open) throttle in `worker.ts`,
  set `clientRegistrationTTL`, delete the false comment.

## Completion-flow change

`handleConsentDecision` (`authorize-route.ts`) today seals **every** absolute redirect into the
loopback `/consent/complete` server-302 bounce (needed because a page at `https://auth.` can't
client-side-navigate to `http://127.0.0.1` — Private Network Access). New logic:

- `isHttpLoopbackRedirect(redirectTo)` → seal + `/consent/complete` bounce (unchanged; PNA).
- absolute `https` → return directly as `redirectTo`; the consent form navigates client-side.
- relative (device flow) → return directly (unchanged).

`openLoopbackRedirect` keeps re-asserting `isHttpLoopbackRedirect` so the server-302 can only ever
target a loopback literal.

## Non-goals / roadmap (separate lane — task #7)

- **CIMD** (domain-proven client identity → true "any client" without an allowlist).
- **OIDC discovery** `/.well-known/openid-configuration` (currently 404 — some 2025-11-25 clients probe it).
- **Consent screen** redirect-host + "unverified app" display (required only if we later open to
  arbitrary https; a human-UI hard stop).
- **Dashboard active-grants + one-click revoke** and shorter refresh TTL for DCR clients (DA "R5").
- **Apply IPv6 `/64` bucketing to the shared `edgeRateLimit`** (token/authorize/device) and dedup the
  throttle helper — the `/64` fix currently lives only in `register-guard` (code-review [5]/[6]/[7]);
  a pre-existing gap, not introduced here, so tracked as a follow-up rather than widening this PR.

## Testing

- `dcr.test.ts` rewritten: assert the spec-correct policy + real-client redirect fixtures + all
  bypass strings (userinfo, punycode, suffix, plain-http-remote, dangerous schemes, own-origin).
- New unit tests for `isHttpLoopbackRedirect`, the register rate-limit core, and the
  `authorize-route` bounce-vs-direct branch.
- Bearer path (`whk_`) verified via existing `apps/mcp` tests + an explicit end-to-end check.
- Full gate (typecheck, lint, unit, `deploy:dry`/`build:cf`) + `/code-review` + `/security-review`
  before merge.
