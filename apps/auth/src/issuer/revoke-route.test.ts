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

  it("rejects an oversized body with 400 invalid_request (before resolving)", async () => {
    const d = deps();
    const huge = new Request("https://auth.webhook.co/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${"a".repeat(3000)}`,
    });
    const res = await handleRevokeRequest(d, huge);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
    expect(d.resolveAccessTokenGrant).not.toHaveBeenCalled();
    expect(d.revokeGrantAndEvict).not.toHaveBeenCalled();
  });

  it("caps on UTF-8 BYTES, not UTF-16 units: a multibyte body under the char count but over the byte budget is rejected", async () => {
    // "𝟙" (U+1D7D9) is 2 UTF-16 code units but 4 UTF-8 bytes. 800 of them → ~1.6k JS-string
    // length (under 2048) but ~3.2k bytes (over the 2048-byte cap). A `.length` check would
    // wrongly admit this; the byte measurement rejects it.
    const d = deps();
    const body = `token=${"𝟙".repeat(800)}`;
    expect(body.length).toBeLessThan(2048); // under the cap by UTF-16 units
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(2048); // over it by bytes
    const req = new Request("https://auth.webhook.co/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const res = await handleRevokeRequest(d, req);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
    expect(d.resolveAccessTokenGrant).not.toHaveBeenCalled();
    expect(d.revokeGrantAndEvict).not.toHaveBeenCalled();
  });
});
