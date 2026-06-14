import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Exercises the real OAuthProvider in workerd (Miniflare): the RFC 9728 / 8414 discovery surface,
// the 401 resource-server challenge, RFC 7591 DCR, and the OAuth 2.1 hardening (S256-only PKCE).
// These prove the resource-server obligations our hand-wired auth.ts used to hand-roll are now met
// by the provider, against our actual config.

const ORIGIN = "https://mcp.webhook.co";

describe("mcp OAuth provider — RFC 9728 protected-resource metadata", () => {
  it("advertises our canonical resource, this co-located issuer, and the capability scopes", async () => {
    const res = await SELF.fetch(`${ORIGIN}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const prm = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
      bearer_methods_supported: string[];
    };
    expect(prm.resource).toBe(ORIGIN);
    expect(prm.authorization_servers).toContain(ORIGIN);
    expect(prm.scopes_supported).toContain("events:read");
    expect(prm.bearer_methods_supported).toContain("header");
  });
});

describe("mcp OAuth provider — RFC 8414 authorization-server metadata", () => {
  it("advertises S256-only PKCE and the issuer endpoints", async () => {
    const res = await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const md = (await res.json()) as {
      code_challenge_methods_supported: string[];
      token_endpoint: string;
      registration_endpoint: string;
    };
    expect(md.code_challenge_methods_supported).toEqual(["S256"]);
    expect(md.token_endpoint.endsWith("/token")).toBe(true);
    expect(md.registration_endpoint.endsWith("/register")).toBe(true);
  });
});

describe("mcp OAuth provider — resource-server challenge + DCR", () => {
  it("rejects an unauthenticated MCP API request with 401 + a Bearer WWW-Authenticate", async () => {
    const res = await SELF.fetch(`${ORIGIN}/mcp`, { method: "POST" });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer/i);
    // RFC 9728: the challenge must point the client at the PRM document so it can discover the
    // issuer and run DCR — not just any Bearer challenge.
    expect(challenge).toContain("resource_metadata=");
    expect(challenge).toContain("/.well-known/oauth-protected-resource");
  });

  it("supports RFC 7591 dynamic client registration", async () => {
    const res = await SELF.fetch(`${ORIGIN}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://client.example/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect([200, 201]).toContain(res.status);
    const client = (await res.json()) as { client_id?: unknown };
    expect(typeof client.client_id).toBe("string");
  });
});
