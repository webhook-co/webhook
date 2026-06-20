import { describe, expect, it, vi } from "vitest";

import { handleRevokeRequest, type RevokeDeps } from "./revoke-route";

// A2b-4b — the pure HTTP contract of the frozen /revoke endpoint (RFC 7009). Parse the urlencoded body,
// discriminate the presented token by prefix (whk_ access key vs rtk_ refresh handle), resolve its grant,
// and revoke-and-evict. RFC 7009: respond 200 for ANY well-formed token request (never leak whether the
// token was valid/known); only a MISSING token is invalid_request. The real resolution/revoke/KV-evict
// (the deps) is the wrangler-layer mount; here the seams are fakes so the contract is unit-testable.

const GRANT = { orgId: "org_1", grantId: "g_1" };

function form(fields: Record<string, string>): Request {
  return new Request("https://auth.webhook.co/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

function deps(over: Partial<RevokeDeps> = {}): RevokeDeps {
  return {
    resolveAccessTokenGrant: vi.fn(async () => GRANT),
    resolveRefreshTokenGrant: vi.fn(async () => GRANT),
    revokeGrantAndEvict: vi.fn(async () => {}),
    ...over,
  };
}

const WHK = `whk_${"a".repeat(43)}`;
const RTK = `rtk_${"b".repeat(43)}`;

describe("handleRevokeRequest", () => {
  it("revokes by a whk_ access key (access resolver), returns 200 no-store empty", async () => {
    const d = deps();
    const res = await handleRevokeRequest(d, form({ token: WHK, client_id: "wbhk" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.text()).toBe("");
    expect(d.resolveAccessTokenGrant).toHaveBeenCalledWith(WHK);
    expect(d.resolveRefreshTokenGrant).not.toHaveBeenCalled();
    expect(d.revokeGrantAndEvict).toHaveBeenCalledWith("org_1", "g_1");
  });

  it("revokes by an rtk_ refresh handle (refresh resolver)", async () => {
    const d = deps();
    const res = await handleRevokeRequest(d, form({ token: RTK }));
    expect(res.status).toBe(200);
    expect(d.resolveRefreshTokenGrant).toHaveBeenCalledWith(RTK);
    expect(d.resolveAccessTokenGrant).not.toHaveBeenCalled();
    expect(d.revokeGrantAndEvict).toHaveBeenCalledWith("org_1", "g_1");
  });

  it("discriminates by PREFIX, not token_type_hint (a whk_ hinted as refresh still uses the access path)", async () => {
    const d = deps();
    await handleRevokeRequest(d, form({ token: WHK, token_type_hint: "refresh_token" }));
    expect(d.resolveAccessTokenGrant).toHaveBeenCalledWith(WHK);
    expect(d.resolveRefreshTokenGrant).not.toHaveBeenCalled();
  });

  it("returns 200 without revoking for an unknown token prefix (no leak)", async () => {
    const d = deps();
    const res = await handleRevokeRequest(d, form({ token: "opaque-or-foreign-token" }));
    expect(res.status).toBe(200);
    expect(d.resolveAccessTokenGrant).not.toHaveBeenCalled();
    expect(d.resolveRefreshTokenGrant).not.toHaveBeenCalled();
    expect(d.revokeGrantAndEvict).not.toHaveBeenCalled();
  });

  it("returns 200 without revoking when the token resolves to no grant (unknown/spent handle)", async () => {
    const d = deps({ resolveAccessTokenGrant: vi.fn(async () => null) });
    const res = await handleRevokeRequest(d, form({ token: WHK }));
    expect(res.status).toBe(200);
    expect(d.revokeGrantAndEvict).not.toHaveBeenCalled();
  });

  it("a missing token is invalid_request (400) — the only error case", async () => {
    const d = deps();
    const res = await handleRevokeRequest(d, form({ client_id: "wbhk" }));
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
    expect(d.revokeGrantAndEvict).not.toHaveBeenCalled();
  });
});
