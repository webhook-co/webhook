# ADR 0110 — no `/.well-known/openid-configuration`: we are a pure OAuth 2.1 AS

- status: accepted
- date: 2026-07-11
- scope: `apps/auth` (discovery)
- relates: [ADR-0109](0109-loopback-redirect-accepts-localhost.md), RFC 8414, OpenID Connect Discovery 1.0,
  the MCP authorization spec (2025-11-25 / draft)

## context

`https://auth.webhook.co/.well-known/openid-configuration` returns **404**, and it was carried on the
backlog as a gap to close — "some clients probe it." That framing is wrong, and closing it as written would
be a regression. This ADR records why the 404 stays.

The MCP authorization spec says an MCP authorization server **MUST** provide **at least one** of RFC 8414
(OAuth AS Metadata) **or** OpenID Connect Discovery 1.0, and that MCP *clients* **MUST** support **both**.
The obligation to try both is on the client; the server owes exactly one. We serve RFC 8414.

Our `issuer` is `https://auth.webhook.co` — **no path component**. Every conformant client therefore builds
exactly two candidate discovery URLs and tries them in order:

1. `https://auth.webhook.co/.well-known/oauth-authorization-server` → we return **200**
2. `https://auth.webhook.co/.well-known/openid-configuration` → **never requested**

So the 404 is unreachable in the normal flow. This matches the field: several major production MCP
servers (including Cloudflare's own) 404 this path and work across every major client.

## decision

**Do not serve `/.well-known/openid-configuration`.** Remain a pure OAuth 2.1 authorization server: opaque
tokens, no `id_token`, no JWKS, no `userinfo`, no `openid` scope.

The decisive argument is that serving it is actively harmful, not merely redundant. The official MCP
TypeScript SDK selects its metadata parser from **which URL answered** — an OAuth schema for the 8414 URL,
an OIDC schema for the openid-configuration URL. Its OIDC schema makes `jwks_uri`, `subject_types_supported`
and `id_token_signing_alg_values_supported` **non-optional**. We have no JWKS to point at (our tokens are
opaque by design). Therefore:

- An **honest** alias (our real OAuth metadata, no OIDC-only claims) fails that schema validation. The
  resulting parse error is **not** caught by the 404-fallback logic — it propagates and **aborts the whole
  authorization flow**. A benign 404 would become a hard failure.
- A **compliant-looking** alias requires fabricating a `jwks_uri` and signing algorithms we do not
  implement — advertising an identity layer we cannot honour, and inviting `scope=openid` requests and
  `id_token` expectations we would answer with nothing.

There is no third option that is both truthful and parseable. The 404 is the correct answer.

## consequences

- We remain conformant on every spec revision (2025-03-26 and 2025-06-18 don't mention OIDC at all;
  2025-11-25 and draft require *at least one* mechanism, and we provide RFC 8414).
- `code_challenge_methods_supported: ["S256"]` must keep being advertised — a spec-compliant client
  **MUST refuse to proceed** if it is absent. Locked by a test in `oauth-config.test.ts`.
- Locked by tests in `oauth-config.test.ts`: no `openid` scope, no JWKS, S256-only. **Do not "fix" the
  404** — read this ADR first.
- If we ever want to be an actual identity provider (SSO into third-party apps), that is a separate product
  decision requiring JWT tokens, a KMS signing key, key rotation, a JWKS endpoint and a userinfo endpoint.
  It is not an MCP-compatibility requirement, and no MCP client needs it.
