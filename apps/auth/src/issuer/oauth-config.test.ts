import { describe, expect, it } from "vitest";

import { oauthIssuerConfig } from "./oauth-config";

// A2b-1 — the OAuth issuer config (the security-relevant knobs of the provider mount). The Worker entry
// (src/worker.ts) spreads this into `new OAuthProvider({ ...oauthIssuerConfig, defaultHandler })`; that
// entry is build:cf/deploy-verified (it imports the generated .open-next handler), so these tests pin the
// config invariants here where they're unit-testable.

describe("oauthIssuerConfig", () => {
  it("claims /oauth/token for the provider — freeing /token for Lane C's frozen-whk_ route (Option B)", () => {
    expect(oauthIssuerConfig.tokenEndpoint).toBe("/oauth/token");
    expect(oauthIssuerConfig.authorizeEndpoint).toBe("/authorize");
    expect(oauthIssuerConfig.clientRegistrationEndpoint).toBe("/register");
  });

  it("is OAuth 2.1 hardened: no implicit flow, S256-only PKCE (no plain)", () => {
    expect(oauthIssuerConfig.allowImplicitFlow).toBe(false);
    expect(oauthIssuerConfig.allowPlainPKCE).toBe(false);
  });

  it("carries an empty apiHandlers (pure issuer) — the provider ctor throws without a handler config", () => {
    // The OAuthProvider/getOAuthApi constructor REQUIRES apiRoute+apiHandler OR apiHandlers, else it throws
    // at construction (not catchable by deploy:dry/build:cf — both bundle-only). {} = zero protected routes
    // (everything falls through to defaultHandler) while satisfying the ctor. Locking it here so a removal
    // can't silently reintroduce the module-construction throw.
    expect(oauthIssuerConfig.apiHandlers).toEqual({});
  });

  it("advertises exactly the CAPABILITY_REGISTRY scopes (the SoT) — sorted, deduped, no keys:manage", () => {
    // Pinned to the exact derived set so a drift between discovery and the mint path fails CI. These are
    // the distinct CAPABILITY_REGISTRY scopes; `keys:manage` (reserved, never granted) is absent.
    expect(oauthIssuerConfig.scopesSupported).toEqual([
      "audit:read",
      "billing:read",
      "endpoints:read",
      "endpoints:write",
      "events:read",
      "events:replay",
      "triggers:write",
    ]);
    // The PRM scope list is the same SoT (discovery + PRM cannot disagree).
    expect(oauthIssuerConfig.resourceMetadata.scopes_supported).toEqual(
      oauthIssuerConfig.scopesSupported,
    );
  });

  it("publishes RFC 9728 PRM for the api. resource via the auth. issuer (header bearer only)", () => {
    expect(oauthIssuerConfig.resourceMetadata.resource).toBe("https://api.webhook.co");
    expect(oauthIssuerConfig.resourceMetadata.authorization_servers).toEqual([
      "https://auth.webhook.co",
    ]);
    expect(oauthIssuerConfig.resourceMetadata.bearer_methods_supported).toEqual(["header"]);
  });

  it("hardens DCR (A3): a clientRegistrationCallback gates redirect_uris; public registration stays enabled", () => {
    // A3 closed the A2b-1 deferral: the callback validates redirect_uris (https or http loopback only — see
    // dcr.test.ts). Public registration is intentionally NOT disabled (the CLI is a public client; the
    // callback is the gate), so disallowPublicClientRegistration stays unset. DCR rate-limit → deploy slice.
    expect(typeof oauthIssuerConfig.clientRegistrationCallback).toBe("function");
    expect(oauthIssuerConfig).not.toHaveProperty("disallowPublicClientRegistration");
  });

  it("enables CIMD — a domain-proven https client_id is the spec's forward path (DCR is deprecated)", () => {
    // CIMD ON lets Claude Code / VS Code / Zed present a domain-proven client_id → shown "verified" on
    // consent. Open to any https client_id, gated by the origin-honest consent screen + the same-origin/
    // loopback redirect fence + the CIMD-fetch throttle (see ./dcr, ./cimd-fetch-guard, ./client-display).
    // The provider advertises client_id_metadata_document_supported only when this AND the
    // global_fetch_strictly_public compat flag are both set.
    expect(oauthIssuerConfig.clientIdMetadataDocumentEnabled).toBe(true);
    // The callback rejects an arbitrary-http redirect, allows loopback.
    expect(
      oauthIssuerConfig.clientRegistrationCallback({
        clientMetadata: { redirect_uris: ["http://evil.example.com/cb"] },
      }),
    ).toMatchObject({ code: "invalid_redirect_uri" });
    expect(
      oauthIssuerConfig.clientRegistrationCallback({
        clientMetadata: { redirect_uris: ["http://127.0.0.1:9000/cb"] },
      }),
    ).toBeUndefined();
  });

  // ── Discovery contract (ADR-0110) ────────────────────────────────────────────────────────────────
  // We serve RFC 8414 and deliberately DO NOT serve /.well-known/openid-configuration. The MCP spec
  // requires an AS to provide *at least one* of RFC 8414 or OIDC Discovery, and requires CLIENTS to try
  // both — our issuer has no path component, so every conformant client builds exactly two candidate URLs,
  // hits /.well-known/oauth-authorization-server FIRST, gets a 200, and never requests the OIDC one.
  //
  // Serving an OIDC alias is not a harmless nicety: the official TS SDK picks its parser from WHICH url
  // answered, and its OIDC schema hard-requires jwks_uri / subject_types_supported /
  // id_token_signing_alg_values_supported. We are an opaque-token AS with no JWKS, so an honest alias would
  // make that parse THROW — and the throw is not caught by the 404-fallback path, so it aborts the whole
  // auth flow. A benign 404 would become a hard failure. Do not "fix" the 404.
  it("advertises S256 PKCE — an MCP client MUST refuse to proceed without code_challenge_methods_supported", () => {
    // The provider derives code_challenge_methods_supported from these two flags; if plain PKCE were ever
    // enabled or the field dropped, every spec-compliant client would (correctly) refuse to authorize.
    expect(oauthIssuerConfig.allowPlainPKCE).toBe(false);
    expect(oauthIssuerConfig.allowImplicitFlow).toBe(false);
  });

  it("stays a pure OAuth 2.1 AS — no OIDC surface is configured (see ADR-0110)", () => {
    // There is no OIDC concept in the provider at all (no jwks_uri, no id_token, no userinfo). Locking this
    // keeps someone from bolting on an `openid` scope or an OIDC discovery alias without reading the ADR:
    // it would advertise an identity layer we do not implement.
    expect(oauthIssuerConfig.scopesSupported).not.toContain("openid");
    expect(oauthIssuerConfig).not.toHaveProperty("jwksUri");
    expect(oauthIssuerConfig.resourceMetadata.scopes_supported).not.toContain("openid");
  });
});
