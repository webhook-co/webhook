// A2b-1 — the OAuth issuer config for auth.webhook.co (everything EXCEPT defaultHandler, which the Worker
// entry supplies as the OpenNext handler). The provider owns its server-side opaque /oauth/token, DCR
// /register, the /authorize parse, and discovery/PRM (.well-known/*); everything else falls through to
// OpenNext — the pages, /api/auth/*, and Lane C's frozen /token + /authorize consent + /device/* + /revoke
// (later slices). tokenEndpoint=/oauth/token deliberately frees /token for the frozen-whk_ route (the
// provider has no token-body hook — Option B, ADR-0024). OAuth 2.1 hardening: S256-only PKCE, no implicit.

import { CAPABILITY_REGISTRY } from "@webhook-co/contract";
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
  // A3 open-DCR hardening: public registration stays enabled (the CLI is a public client —
  // disallowPublicClientRegistration unset), but every redirect_uri is validated to be https or an http
  // loopback literal (127.0.0.1/::1) — rejecting the open-redirect/phishing vector (arbitrary http hosts)
  // and `localhost` (ADR-0026). See ./dcr. Durable DCR rate-limiting is deferred to the deploy slice.
  clientRegistrationCallback: (options: { clientMetadata: Record<string, unknown> }) =>
    validateClientRegistration(options.clientMetadata),
  scopesSupported: [...CAPABILITY_SCOPES],
  allowImplicitFlow: false,
  allowPlainPKCE: false,
  // RFC 9728 PRM, served by the provider at /.well-known/oauth-protected-resource. This intentionally
  // describes ONLY the api. resource: mcp. is a separate origin that publishes its OWN PRM/AS (provider
  // tokens are opaque + KV-bound to the issuing Worker, so mcp. self-issues — see apps/mcp). Do not add
  // mcp. to authorization_servers or a second resource here.
  resourceMetadata: {
    resource: API_RESOURCE,
    authorization_servers: [PROD_AUTH_BASE_URL],
    scopes_supported: [...CAPABILITY_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "webhook.co API",
  },
};
