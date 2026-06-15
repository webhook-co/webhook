import { describe, expect, it } from "vitest";

import {
  AudienceMismatchError,
  assertAudience,
  authenticateBearer,
  AuthContextSchema,
  buildProtectedResourceMetadata,
  buildWwwAuthenticate,
  UnauthenticatedError,
  type AuthContext,
  type BearerAuthzDeps,
} from "./auth";
import { TargetSchema } from "./target";

const RESOURCE = "https://api.webhook.co";
const PRM_URL = "https://api.webhook.co/.well-known/oauth-protected-resource";

/** BearerAuthzDeps over a fake verifyBearer (asserts the resource it's called with). */
function deps(verifyBearer: BearerAuthzDeps["verifyBearer"]): BearerAuthzDeps {
  return { verifyBearer, resource: RESOURCE, resourceMetadataUrl: PRM_URL };
}

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

describe("authenticateBearer (scope-free identity auth)", () => {
  it("returns the AuthContext for a valid token (asserting the bound resource)", async () => {
    const ctx: AuthContext = { orgId: "org_1", scopes: ["events:read"] };
    const res = await authenticateBearer(
      deps(async (_token, audience) => {
        expect(audience).toBe(RESOURCE);
        return ctx;
      }),
      "Bearer tok",
    );
    expect(res).toEqual({ ok: true, ctx });
  });

  it("does not enforce any scope — an authenticated principal with no scopes still passes", async () => {
    const res = await authenticateBearer(
      deps(async () => ({ orgId: "org_1", scopes: [] })),
      "Bearer t",
    );
    expect(res.ok).toBe(true);
  });

  it("401s with an invalid_token challenge when no bearer is presented", async () => {
    const res = await authenticateBearer(
      deps(async () => {
        throw new Error("verifyBearer must not be called without a token");
      }),
      null,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(401);
      expect(res.challenge).toContain('error="invalid_token"');
      expect(res.challenge).toContain("resource_metadata=");
    }
  });

  it("401s on an unauthenticated token (no principal resolves)", async () => {
    const res = await authenticateBearer(
      deps(async () => {
        throw new UnauthenticatedError();
      }),
      "Bearer bad",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it("401s on an audience mismatch (replayed token) without leaking which", async () => {
    const res = await authenticateBearer(
      deps(async () => {
        throw new AudienceMismatchError(RESOURCE, "https://mcp.webhook.co");
      }),
      "Bearer replayed",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it("rethrows an operational fault rather than masking it as a 401", async () => {
    await expect(
      authenticateBearer(
        deps(async () => {
          throw new Error("hyperdrive connection reset");
        }),
        "Bearer x",
      ),
    ).rejects.toThrow("hyperdrive connection reset");
  });
});

describe("AuthContextSchema", () => {
  it("accepts an org + scopes principal, with an optional userId", () => {
    expect(AuthContextSchema.safeParse({ orgId: "org_1", scopes: ["events:read"] }).success).toBe(
      true,
    );
    expect(
      AuthContextSchema.safeParse({ orgId: "org_1", userId: "usr_2", scopes: [] }).success,
    ).toBe(true);
  });

  it("rejects a principal missing orgId or scopes", () => {
    expect(AuthContextSchema.safeParse({ scopes: [] }).success).toBe(false);
    expect(AuthContextSchema.safeParse({ orgId: "org_1" }).success).toBe(false);
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
