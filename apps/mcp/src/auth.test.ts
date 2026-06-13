import { UnauthenticatedError, type AuthContext, type VerifyBearer } from "@webhook-co/contract";
import { describe, expect, it } from "vitest";

import { authorize, extractBearer, protectedResourceMetadata, type McpAuthDeps } from "./auth";

const RESOURCE = "https://mcp.webhook.co";
const PRM_URL = "https://mcp.webhook.co/.well-known/oauth-protected-resource";
const AS = ["https://auth.webhook.co"];
const ORG = "44444444-4444-7444-8444-444444444444";

function fakeVerify(result: AuthContext | { throws: unknown }): VerifyBearer {
  return async () => {
    if ("throws" in result) throw result.throws;
    return result;
  };
}

function deps(verifyBearer: VerifyBearer): McpAuthDeps {
  return {
    verifyBearer,
    resource: RESOURCE,
    resourceMetadataUrl: PRM_URL,
    authorizationServers: AS,
  };
}

function reqWith(token?: string): Request {
  const headers = new Headers();
  // eslint-disable-next-line security/detect-possible-timing-attacks -- a presence check on a test fixture, not a secret compare
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  return new Request("https://mcp.webhook.co/", { headers });
}

describe("protectedResourceMetadata (RFC 9728)", () => {
  it("advertises the resource, the auth servers, and the capability scopes", () => {
    const prm = protectedResourceMetadata(deps(fakeVerify({ orgId: ORG, scopes: [] })));
    expect(prm.resource).toBe(RESOURCE);
    expect(prm.authorization_servers).toEqual(AS);
    expect(prm.bearer_methods_supported).toContain("header");
    // The real capability scopes are surfaced (e.g. events:read, audit:read).
    expect(prm.scopes_supported).toContain("events:read");
    expect(prm.scopes_supported).toContain("audit:read");
  });
});

describe("authorize — same seam as the API, plus PRM", () => {
  it("allows a scoped request", async () => {
    const ctx: AuthContext = { orgId: ORG, scopes: ["audit:read"] };
    const result = await authorize(deps(fakeVerify(ctx)), reqWith("whk_ok"), "audit.verify");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ctx.orgId).toBe(ORG);
  });

  it("401s when unauthenticated", async () => {
    const ctx: AuthContext = { orgId: ORG, scopes: ["audit:read"] };
    const result = await authorize(deps(fakeVerify(ctx)), reqWith(), "audit.verify");
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it("403s when authenticated but under-scoped", async () => {
    const ctx: AuthContext = { orgId: ORG, scopes: ["events:read"] };
    const result = await authorize(deps(fakeVerify(ctx)), reqWith("whk_ok"), "audit.verify");
    expect(result).toMatchObject({ ok: false, status: 403 });
    if (!result.ok) expect(result.challenge).toContain('error="insufficient_scope"');
  });

  it("401s when verifyBearer throws UnauthenticatedError (bad or replayed credential)", async () => {
    const result = await authorize(
      deps(fakeVerify({ throws: new UnauthenticatedError() })),
      reqWith("whk_bad"),
      "audit.verify",
    );
    expect(result).toMatchObject({ ok: false, status: 401 });
    if (!result.ok) expect(result.challenge).toContain('error="invalid_token"');
  });

  it("PROPAGATES an operational error instead of masking it as a 401", async () => {
    await expect(
      authorize(
        deps(fakeVerify({ throws: new Error("hyperdrive: connection reset") })),
        reqWith("whk_ok"),
        "audit.verify",
      ),
    ).rejects.toThrow(/connection reset/);
  });

  it("throws on an unknown capability (programming error, fail closed)", async () => {
    const ctx: AuthContext = { orgId: ORG, scopes: [] };
    await expect(
      authorize(deps(fakeVerify(ctx)), reqWith("whk_ok"), "nope.invalid"),
    ).rejects.toThrow(/unknown capability/);
  });

  it("extractBearer pulls the token", () => {
    expect(extractBearer(reqWith("whk_xyz"))).toBe("whk_xyz");
  });
});
