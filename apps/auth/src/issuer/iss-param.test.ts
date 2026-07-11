import { describe, expect, it } from "vitest";

import { augmentAsMetadata, augmentAsMetadataResponse } from "./as-metadata";
import { withIssParam } from "./iss-param";

// RFC 9207: the honest AS stamps its identity onto the authorization response so a client can detect a
// mix-up attack (a code from one AS being redeemed at another's token endpoint). PKCE does not prevent it.

describe("withIssParam", () => {
  it("stamps iss onto a success redirect (alongside code + state)", () => {
    const out = withIssParam(
      "http://127.0.0.1:8976/callback?code=abc&state=xyz",
      "https://auth.webhook.co",
    );
    const url = new URL(out);
    expect(url.searchParams.get("iss")).toBe("https://auth.webhook.co");
    // must not disturb what the provider already put there
    expect(url.searchParams.get("code")).toBe("abc");
    expect(url.searchParams.get("state")).toBe("xyz");
  });

  it("stamps iss onto an ERROR redirect too — the spec requires it on error responses", () => {
    // Without iss on errors, an attacker's AS can replay an honest server's error response; the client is
    // required to refuse to act on error/error_description it cannot attribute.
    const out = withIssParam(
      "https://claude.ai/api/mcp/auth_callback?error=access_denied&state=s1",
      "https://auth.webhook.co",
    );
    const url = new URL(out);
    expect(url.searchParams.get("iss")).toBe("https://auth.webhook.co");
    expect(url.searchParams.get("error")).toBe("access_denied");
  });

  it("leaves a RELATIVE location untouched — the device status page is not an authorization response", () => {
    expect(withIssParam("/device?status=approved", "https://auth.webhook.co")).toBe(
      "/device?status=approved",
    );
    expect(withIssParam("/device?status=denied", "https://auth.webhook.co")).toBe(
      "/device?status=denied",
    );
  });

  it("overwrites a client-supplied iss rather than appending a second one", () => {
    // A client could smuggle ?iss=<attacker> into its registered redirect_uri. Two iss params would let a
    // lax client read the attacker's. set() (not append()) collapses it to exactly one — ours.
    const out = withIssParam(
      "http://127.0.0.1:5000/cb?iss=https://evil.example&code=abc",
      "https://auth.webhook.co",
    );
    const url = new URL(out);
    expect(url.searchParams.getAll("iss")).toEqual(["https://auth.webhook.co"]);
  });
});

describe("augmentAsMetadata", () => {
  it("advertises authorization_response_iss_parameter_supported (RFC 9207 §2.3 MUST)", () => {
    const doc = augmentAsMetadata({ issuer: "https://auth.webhook.co" }) as Record<string, unknown>;
    expect(doc.authorization_response_iss_parameter_supported).toBe(true);
    expect(doc.issuer).toBe("https://auth.webhook.co");
  });

  it("does not advertise any OIDC surface (ADR-0110)", () => {
    const doc = augmentAsMetadata({ issuer: "https://auth.webhook.co" }) as Record<string, unknown>;
    expect(doc).not.toHaveProperty("jwks_uri");
    expect(doc).not.toHaveProperty("id_token_signing_alg_values_supported");
    expect(doc).not.toHaveProperty("userinfo_endpoint");
  });

  it("passes a non-object document through untouched (never break discovery on a shape surprise)", () => {
    expect(augmentAsMetadata(null)).toBeNull();
    expect(augmentAsMetadata("nope")).toBe("nope");
    expect(augmentAsMetadata([1])).toEqual([1]);
  });
});

describe("augmentAsMetadataResponse", () => {
  const metadataRequest = () =>
    new Request("https://auth.webhook.co/.well-known/oauth-authorization-server");

  it("merges the advertisement into the provider's metadata response", async () => {
    const upstream = new Response(JSON.stringify({ issuer: "https://auth.webhook.co" }), {
      status: 200,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    });
    const out = await augmentAsMetadataResponse(metadataRequest(), upstream);
    const doc = (await out.json()) as Record<string, unknown>;
    expect(doc.authorization_response_iss_parameter_supported).toBe(true);
    // the provider's CORS must survive — discovery is fetched cross-origin by browser MCP clients
    expect(out.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("leaves every other path alone", async () => {
    const req = new Request("https://auth.webhook.co/.well-known/oauth-protected-resource");
    const upstream = new Response(JSON.stringify({ resource: "https://api.webhook.co" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const out = await augmentAsMetadataResponse(req, upstream);
    const doc = (await out.json()) as Record<string, unknown>;
    expect(doc).not.toHaveProperty("authorization_response_iss_parameter_supported");
  });

  it("passes a non-200 straight through (never rewrite a provider error)", async () => {
    const upstream = new Response("nope", { status: 500 });
    const out = await augmentAsMetadataResponse(metadataRequest(), upstream);
    expect(out.status).toBe(500);
    expect(await out.text()).toBe("nope");
  });

  it("passes a non-JSON 200 straight through", async () => {
    const upstream = new Response("not json", { status: 200 });
    const out = await augmentAsMetadataResponse(metadataRequest(), upstream);
    expect(await out.text()).toBe("not json");
  });
});
