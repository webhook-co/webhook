import { describe, expect, it } from "vitest";

import {
  AudienceMismatchError,
  assertAudience,
  buildProtectedResourceMetadata,
  buildWwwAuthenticate,
} from "./auth";
import { TargetSchema } from "./target";

describe("audience binding (RFC 8707/9728)", () => {
  it("accepts a matching audience", () => {
    expect(() => assertAudience("https://mcp.webhook.co", "https://mcp.webhook.co")).not.toThrow();
  });

  it("rejects a mismatched or absent audience", () => {
    expect(() => assertAudience("https://api.webhook.co", "https://mcp.webhook.co")).toThrow(
      AudienceMismatchError,
    );
    expect(() => assertAudience(undefined, "https://mcp.webhook.co")).toThrow(
      AudienceMismatchError,
    );
  });
});

describe("RFC 9728 protected-resource metadata", () => {
  it("advertises the resource + authorization servers", () => {
    const prm = buildProtectedResourceMetadata({
      resource: "https://mcp.webhook.co",
      authorizationServers: ["https://auth.webhook.co"],
      scopesSupported: ["events:read"],
    });
    expect(prm.resource).toBe("https://mcp.webhook.co");
    expect(prm.authorization_servers).toEqual(["https://auth.webhook.co"]);
    expect(prm.bearer_methods_supported).toContain("header");
    expect(prm.scopes_supported).toEqual(["events:read"]);
  });

  it("builds a WWW-Authenticate challenge pointing at the PRM document", () => {
    const challenge = buildWwwAuthenticate(
      "https://mcp.webhook.co/.well-known/oauth-protected-resource",
      "invalid_token",
    );
    expect(challenge).toContain(
      'resource_metadata="https://mcp.webhook.co/.well-known/oauth-protected-resource"',
    );
    expect(challenge).toContain('error="invalid_token"');
  });
});

describe("closed replay target", () => {
  it("accepts the localhost tunnel and rejects anything else", () => {
    expect(TargetSchema.safeParse({ kind: "localhost-tunnel", sessionId: "s1" }).success).toBe(
      true,
    );
    expect(TargetSchema.safeParse({ kind: "https", url: "https://evil.example" }).success).toBe(
      false,
    );
  });
});
