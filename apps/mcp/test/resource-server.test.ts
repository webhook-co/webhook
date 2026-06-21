import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// A8b — exercises the real mcp RESOURCE SERVER in workerd (Miniflare), now that the co-located
// OAuthProvider issuer is torn down. It proves the resource-server obligations are met by our hand-wired
// router (resource-handler.ts): the RFC 9728 PRM points at the auth. issuer, an unauthenticated /mcp
// request gets the RFC 6750 challenge, and the former ISSUER endpoints (RFC 8414 metadata, DCR) are GONE.

const ORIGIN = "https://mcp.webhook.co";
const AUTH_ISSUER = "https://auth.webhook.co";

describe("mcp resource server — RFC 9728 protected-resource metadata", () => {
  it("advertises our resource + the AUTH. issuer as the authorization server (not mcp itself)", async () => {
    const res = await SELF.fetch(`${ORIGIN}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const prm = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
      bearer_methods_supported: string[];
    };
    expect(prm.resource).toBe(ORIGIN);
    // The issuer moved to auth. (Lane C) — mcp is no longer its own authorization server.
    expect(prm.authorization_servers).toEqual([AUTH_ISSUER]);
    expect(prm.authorization_servers).not.toContain(ORIGIN);
    expect(prm.scopes_supported).toContain("events:read");
    expect(prm.bearer_methods_supported).toContain("header");
  });
});

describe("mcp resource server — RFC 6750 challenge", () => {
  it("rejects an unauthenticated MCP request with 401 + a PRM-pointing Bearer WWW-Authenticate", async () => {
    const res = await SELF.fetch(`${ORIGIN}/mcp`, { method: "POST" });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer/i);
    // RFC 9728: the challenge must point the client at the PRM document so it can discover the issuer.
    expect(challenge).toContain("resource_metadata=");
    expect(challenge).toContain("/.well-known/oauth-protected-resource");
  });
});

describe("mcp resource server — the issuer endpoints are gone (teardown)", () => {
  it("no longer serves RFC 8414 authorization-server metadata (mcp is not an issuer)", async () => {
    const res = await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(404);
  });

  it("no longer offers RFC 7591 dynamic client registration", async () => {
    const res = await SELF.fetch(`${ORIGIN}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://client.example/callback"] }),
    });
    expect(res.status).toBe(404);
  });

  it("no longer serves the /token endpoint", async () => {
    const res = await SELF.fetch(`${ORIGIN}/token`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("mcp resource server — health", () => {
  it("serves a health check", async () => {
    const res = await SELF.fetch(`${ORIGIN}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ok");
  });
});
