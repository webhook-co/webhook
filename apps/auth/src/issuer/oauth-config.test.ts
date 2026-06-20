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

  it("leaves DCR hardening unset — deferred to A3 (clientRegistrationCallback + DCR rate-limit)", () => {
    // Documents the deliberate gap: open DCR is acceptable while the issuer is NOT routed; A3 adds the
    // loopback-redirect callback + rate-limit before go-live. Making A3's addition a deliberate edit here.
    expect(oauthIssuerConfig).not.toHaveProperty("clientRegistrationCallback");
    expect(oauthIssuerConfig).not.toHaveProperty("disallowPublicClientRegistration");
  });
});
