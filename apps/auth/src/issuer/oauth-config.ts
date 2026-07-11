// A2b-1 — the OAuth issuer config for auth.webhook.co (everything EXCEPT defaultHandler, which the Worker
// entry supplies as the OpenNext handler). The provider owns its server-side opaque /oauth/token, DCR
// /register, the /authorize parse, and discovery/PRM (.well-known/*); everything else falls through to
// OpenNext — the pages, /api/auth/*, and Lane C's frozen /token + /authorize consent + /device/* + /revoke
// (later slices). tokenEndpoint=/oauth/token deliberately frees /token for the frozen-whk_ route (the
// provider has no token-body hook — Option B, ADR-0024). OAuth 2.1 hardening: S256-only PKCE, no implicit.

import { CAPABILITY_REGISTRY, PROFILE_SCOPE } from "@webhook-co/contract";
import { API_RESOURCE } from "@webhook-co/db";

import { validateClientRegistration } from "./dcr";
import { PROD_AUTH_BASE_URL } from "../runtime/urls";

// The capability scopes the issuer advertises (RFC 8414 scopes_supported + the RFC 9728 PRM below).
// Derived from the single SoT — @webhook-co/contract's CAPABILITY_REGISTRY (the same set apps/mcp's
// SCOPES_SUPPORTED derives from) — so discovery can never advertise a scope the mint path rejects (or
// omit one it grants). The RESERVED `keys:manage` is not a capability scope, so it's absent by
// construction (reserve-name-only, never granted). The token + device-code mint paths (token-deps,
// device-authorize-deps) import THIS export so the advertised set and the mintable set can't drift.
export const CAPABILITY_SCOPES = [
  ...new Set([...CAPABILITY_REGISTRY.values()].map((c) => c.auth.scope)),
].sort();

// Every scope the issuer will ADVERTISE, CONSENT to, and MINT — the capability scopes plus `profile` (the
// identity scope, single-sourced from @webhook-co/contract). This is
// the single source the advertise / consent-intersect / mint-intersect points all use, so `profile` can't
// drift (advertised but not mintable, or consented but dropped at mint). MUST stay in sync across those 7
// auth-side references + the mcp PRM.
export const GRANTABLE_SCOPES = [...CAPABILITY_SCOPES, PROFILE_SCOPE].sort();

export const oauthIssuerConfig = {
  // Pure issuer = NO protected API routes (auth. is the authorization server, not a resource server). But
  // the provider's constructor (used by `new OAuthProvider` AND `getOAuthApi`) REQUIRES a handler config —
  // it throws "Must provide either apiRoute + apiHandler OR apiHandlers" when neither is set (oauth-provider
  // .js ctor). An empty `apiHandlers: {}` satisfies it (truthy) while registering zero API routes, so
  // everything still falls through to defaultHandler. WITHOUT this the Worker throws at module construction
  // (deploy:dry is bundle-only + getOAuthApi can't load under vitest, so the gate can't catch a regression
  // — the lock test in oauth-config.test.ts guards it). Do not remove.
  apiHandlers: {},
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/register",
  // Open-DCR policy: public registration stays enabled (public clients register themselves —
  // disallowPublicClientRegistration unset), but every redirect_uri is validated to be an http loopback
  // (127.0.0.1/::1/localhost, any port) OR an allowlisted-vendor https callback — the MCP spec's
  // "localhost or HTTPS" rule, with open https narrowed to known clients so it can't be a consent-phishing
  // vector. See ./dcr. POST /register is rate-limited in the Worker entry (register-guard), before the
  // provider serves it.
  clientRegistrationCallback: (options: { clientMetadata: Record<string, unknown> }) =>
    validateClientRegistration(options.clientMetadata),
  // Pin the registered-client lifetime (the provider's current default is 90 days) so a registered client —
  // junk or real — can't outlive this window, and a future library-default change can't silently alter it.
  // DCR clients transparently re-register when their cached client_id is rejected.
  clientRegistrationTTL: 90 * 24 * 60 * 60,
  // CIMD (Client ID Metadata Documents): accept an https-URL client_id resolved to a self-hosted metadata
  // doc — the MCP spec's forward path (DCR is deprecated). This lets a client present a DOMAIN-PROVEN
  // identity (Claude Code → claude.ai, VS Code → vscode.dev, Zed → zed.dev), which the consent screen shows
  // as "verified". Open to any https client_id (founder decision 2026-07-11); the phishing surface an open
  // registration would otherwise create is neutralized by (a) the origin-honest consent screen — the
  // un-spoofable identity domain + redirect host + an "unverified app" warning + Deny-dominant for a remote
  // unverified client, (b) the same-origin-or-loopback redirect fence (isCimdRedirectAllowed — the provider's
  // registration callback never runs on the CIMD path, so consent-core is the gate), and (c) the tighter
  // pre-auth CIMD-fetch throttle. Requires the `global_fetch_strictly_public` compat flag (set in
  // wrangler.jsonc) for SSRF safety; the provider advertises client_id_metadata_document_supported only when
  // BOTH are true. Follow-up safety net: connected-apps + one-click revoke.
  clientIdMetadataDocumentEnabled: true,
  scopesSupported: [...GRANTABLE_SCOPES],
  allowImplicitFlow: false,
  allowPlainPKCE: false,
  // RFC 9728 PRM, served by the provider at /.well-known/oauth-protected-resource. This intentionally
  // describes ONLY the api. resource: mcp. is a separate origin that publishes its OWN PRM/AS (provider
  // tokens are opaque + KV-bound to the issuing Worker, so mcp. self-issues — see apps/mcp). Do not add
  // mcp. to authorization_servers or a second resource here.
  resourceMetadata: {
    resource: API_RESOURCE,
    authorization_servers: [PROD_AUTH_BASE_URL],
    scopes_supported: [...GRANTABLE_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "webhook.co API",
  },
};
