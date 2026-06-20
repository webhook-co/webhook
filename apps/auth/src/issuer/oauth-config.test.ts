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
      "endpoints:read",
      "events:read",
      "events:replay",
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
});
