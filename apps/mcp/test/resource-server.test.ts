import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/** The published MCP Registry manifest — the root redirect must agree with what it advertises. */
import SERVER_MANIFEST from "../server.json";

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

// The root used to 404. Nothing is mounted there — `/mcp` is the endpoint — but the registry
// listing and our own docs both name the bare host (`mcp.webhook.co`), so a human who pastes it
// into a browser is a normal thing to happen, and a 404 tells them the service is broken when it
// is not. Now that the server is listed publicly, that first impression is worth fixing.
describe("mcp resource server — the root", () => {
  it("redirects a browser at the bare host to the docs instead of 404ing", async () => {
    const res = await SELF.fetch(`${ORIGIN}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(SERVER_MANIFEST.websiteUrl);
  });

  it("sends the human to the SAME page the registry listing advertises", () => {
    // Two audiences, one destination: `websiteUrl` in server.json is what every MCP client and
    // aggregator shows, so the root must not drift to some other page.
    expect(SERVER_MANIFEST.websiteUrl).toBe("https://docs.webhook.co/mcp/overview");
  });

  it("answers HEAD too, so a link checker sees the redirect rather than a 404", async () => {
    const res = await SELF.fetch(`${ORIGIN}/`, { method: "HEAD", redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(SERVER_MANIFEST.websiteUrl);
  });

  it("does NOT pretend the root is an MCP endpoint", async () => {
    // A client that POSTs JSON-RPC to the bare host has the wrong URL. Redirecting it to an HTML
    // docs page would turn that into a confusing parse error; 404 is the honest answer.
    const res = await SELF.fetch(`${ORIGIN}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      redirect: "manual",
    });
    expect(res.status).not.toBe(302);
  });

  it("still 404s an unknown path (the redirect is the root only, not a catch-all)", async () => {
    const res = await SELF.fetch(`${ORIGIN}/not-a-real-path`, { redirect: "manual" });
    expect(res.status).toBe(404);
  });
});
