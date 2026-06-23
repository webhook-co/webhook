import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { oauthIssuerConfig } from "./oauth-config";

// A workerd boot-smoke for the auth. issuer. apps/auth's other tests are jsdom-only, so NOTHING
// exercised the REAL @cloudflare/workers-oauth-provider `OAuthProvider` until this file: its ctor
// runs only inside the workerd runtime (it touches `cloudflare:workers`), and a latent prod bug
// once existed where the ctor THREW without a handler config (the A2b-5 fix added
// `apiHandlers: {}`). The jsdom gate can't construct the provider, and `deploy:dry` is bundle-only
// (it never runs the module), so neither could catch a ctor-throw regression. This boots the
// provider from the SAME oauthIssuerConfig the Worker entry (src/worker.ts) spreads, then asserts
// RFC 8414 discovery responds — proving the ctor doesn't throw AND the discovery wiring is intact,
// in real workerd, WITHOUT the OpenNext build (we don't import the generated .open-next/worker.js).
//
// We supply a trivial defaultHandler (404) here standing in for the OpenNext handler the Worker
// supplies — discovery is served by the provider itself and never falls through to it, so a stub
// is enough to construct a valid provider.
const DISCOVERY_URL = "https://auth.webhook.co/.well-known/oauth-authorization-server";

function makeProvider(): OAuthProvider {
  return new OAuthProvider({
    ...oauthIssuerConfig,
    defaultHandler: { fetch: async () => new Response(null, { status: 404 }) },
  });
}

describe("auth issuer — OAuthProvider boots in workerd", () => {
  it("constructs the real provider from oauthIssuerConfig without throwing (the A2b-5 ctor guard)", () => {
    // The throw class this guards: `new OAuthProvider(...)` throws a TypeError
    // ("Must provide either apiRoute + apiHandler OR apiHandlers") when no handler config is set.
    // `apiHandlers: {}` in oauthIssuerConfig satisfies it — removing it would throw HERE.
    expect(() => makeProvider()).not.toThrow();
  });

  it("serves RFC 8414 authorization-server metadata (discovery is wired through the ctor)", async () => {
    const provider = makeProvider();
    const ctx = createExecutionContext();
    const res = await provider.fetch(new Request(DISCOVERY_URL), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const metadata = (await res.json()) as {
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      scopes_supported: string[];
    };

    // RFC 8414 required/expected fields, derived from the live config (so the smoke test also
    // proves the provider surfaces our endpoint + scope choices, not just that it returns 200).
    // The provider resolves the config's relative endpoint paths against the request origin into
    // the absolute URLs the metadata advertises.
    const origin = new URL(DISCOVERY_URL).origin;
    expect(metadata.issuer).toBe(origin);
    expect(metadata.authorization_endpoint).toBe(`${origin}${oauthIssuerConfig.authorizeEndpoint}`);
    expect(metadata.token_endpoint).toBe(`${origin}${oauthIssuerConfig.tokenEndpoint}`);
    expect(metadata.scopes_supported).toEqual(oauthIssuerConfig.scopesSupported);
  });
});
