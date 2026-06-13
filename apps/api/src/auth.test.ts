import {
  AudienceMismatchError,
  UnauthenticatedError,
  type AuthContext,
  type VerifyBearer,
} from "@webhook-co/contract";
import { describe, expect, it } from "vitest";

import { authorize, extractBearer, type ApiAuthDeps } from "./auth";

const RESOURCE = "https://api.webhook.co";
const PRM_URL = "https://api.webhook.co/.well-known/oauth-protected-resource";
const ORG = "33333333-3333-7333-8333-333333333333";

/** A fake verifyBearer (the contract seam) — the surface never sees the real impl. */
function fakeVerify(result: AuthContext | { throws: unknown }): VerifyBearer {
  return async () => {
    if ("throws" in result) throw result.throws;
    return result;
  };
}

function deps(verifyBearer: VerifyBearer): ApiAuthDeps {
  return { verifyBearer, resource: RESOURCE, resourceMetadataUrl: PRM_URL };
}

function reqWith(token?: string): Request {
  const headers = new Headers();
  // eslint-disable-next-line security/detect-possible-timing-attacks -- a presence check on a test fixture, not a secret compare
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  return new Request("https://api.webhook.co/v1/endpoints", { headers });
}

describe("extractBearer", () => {
  it("returns the token from a Bearer header", () => {
    expect(extractBearer(reqWith("whk_abc"))).toBe("whk_abc");
  });
  it("returns null when there is no Authorization header", () => {
    expect(extractBearer(new Request("https://api.webhook.co/"))).toBeNull();
  });
  it("returns null for a non-Bearer scheme", () => {
    const req = new Request("https://api.webhook.co/", {
      headers: { authorization: "Basic abc" },
    });
    expect(extractBearer(req)).toBeNull();
  });
  it("accepts a case-insensitive scheme and extra spaces (RFC 6750/7235)", () => {
    const req = new Request("https://api.webhook.co/", {
      headers: { authorization: "bearer   whk_ci" },
    });
    expect(extractBearer(req)).toBe("whk_ci");
  });
});

describe("authorize — resolves AuthContext + enforces capability scope", () => {
  it("allows a scoped, audience-bound request", async () => {
    const ctx: AuthContext = { orgId: ORG, scopes: ["endpoints:read"] };
    const result = await authorize(deps(fakeVerify(ctx)), reqWith("whk_ok"), "endpoints.list");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ctx.orgId).toBe(ORG);
  });

  it("401s with an invalid_token challenge when no credential is present", async () => {
    const ctx: AuthContext = { orgId: ORG, scopes: ["endpoints:read"] };
    const result = await authorize(deps(fakeVerify(ctx)), reqWith(), "endpoints.list");
    expect(result).toMatchObject({ ok: false, status: 401 });
    if (!result.ok) expect(result.challenge).toContain('error="invalid_token"');
  });

  it("401s when verifyBearer throws UnauthenticatedError (bad credential)", async () => {
    const result = await authorize(
      deps(fakeVerify({ throws: new UnauthenticatedError() })),
      reqWith("whk_bad"),
      "endpoints.list",
    );
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it("PROPAGATES an operational error instead of masking it as a 401", async () => {
    // A DB/Hyperdrive/KMS outage (not an auth rejection) must surface as a 5xx, not be
    // silently reclassified as 'your token is invalid'.
    await expect(
      authorize(
        deps(fakeVerify({ throws: new Error("hyperdrive: connection reset") })),
        reqWith("whk_ok"),
        "endpoints.list",
      ),
    ).rejects.toThrow(/connection reset/);
  });

  it("401s (not 403) when the token's audience does not match the resource", async () => {
    const result = await authorize(
      deps(fakeVerify({ throws: new AudienceMismatchError(RESOURCE, "https://other") })),
      reqWith("whk_replayed"),
      "endpoints.list",
    );
    // Replayed-token (wrong audience) is indistinguishable from invalid to the client.
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it("403s with insufficient_scope when authenticated but under-scoped", async () => {
    const ctx: AuthContext = { orgId: ORG, scopes: ["endpoints:read"] };
    // events.replay needs events:replay, which this principal lacks.
    const result = await authorize(deps(fakeVerify(ctx)), reqWith("whk_ok"), "events.replay");
    expect(result).toMatchObject({ ok: false, status: 403 });
    if (!result.ok) expect(result.challenge).toContain('error="insufficient_scope"');
  });

  it("throws on an unknown capability (programming error, fail closed)", async () => {
    const ctx: AuthContext = { orgId: ORG, scopes: [] };
    await expect(
      authorize(deps(fakeVerify(ctx)), reqWith("whk_ok"), "nope.invalid"),
    ).rejects.toThrow(/unknown capability/);
  });

  it("passes the resource as the audience to verifyBearer", async () => {
    let seenAudience = "";
    const verify: VerifyBearer = async (_t, audience) => {
      seenAudience = audience;
      return { orgId: ORG, scopes: ["endpoints:read"] };
    };
    await authorize(deps(verify), reqWith("whk_ok"), "endpoints.list");
    expect(seenAudience).toBe(RESOURCE);
  });
});
