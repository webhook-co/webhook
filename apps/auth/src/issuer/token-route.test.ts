import { describe, expect, it, vi } from "vitest";

import { handleTokenRequest, type TokenRouteDeps } from "./token-route";
import type { FrozenTokenBody, RedeemResult } from "./token-core";

// A2b-2b — the pure HTTP contract of the frozen /token route (RFC 6749 §5): parse the urlencoded body,
// dispatch on grant_type to the injected redeem cores, and map RedeemResult → an OAuth token/error
// response with no-store caching. The real provider/db wiring (the deps) is the Next mount; here the
// redeem cores are fakes so the HTTP contract is unit-testable.

const FROZEN: FrozenTokenBody = {
  access_token: `whk_${"a".repeat(40)}`,
  token_type: "Bearer",
  expires_in: 86_400,
  refresh_token: `rtk_${"b".repeat(40)}`,
  scope: "events:read",
  resource: "https://api.webhook.co",
};

function form(fields: Record<string, string>): Request {
  return new Request("https://auth.webhook.co/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

function deps(over: Partial<TokenRouteDeps> = {}): TokenRouteDeps {
  return {
    redeemAuthCode: vi.fn(async (): Promise<RedeemResult> => ({ kind: "token", body: FROZEN })),
    ...over,
  };
}

const AUTH_CODE_FIELDS = {
  grant_type: "authorization_code",
  code: "code_1",
  code_verifier: "verifier_1",
  redirect_uri: "http://127.0.0.1:53123/cb",
  client_id: "wbhk",
  resource: "https://api.webhook.co",
};

describe("handleTokenRequest — authorization_code", () => {
  it("returns 200 + the frozen body as JSON, with no-store caching", async () => {
    const res = await handleTokenRequest(deps(), form(AUTH_CODE_FIELDS));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toEqual(FROZEN);
  });

  it("passes the parsed code-grant request through to redeemAuthCode", async () => {
    const d = deps();
    await handleTokenRequest(d, form(AUTH_CODE_FIELDS));
    expect(d.redeemAuthCode).toHaveBeenCalledWith({
      grant_type: "authorization_code",
      code: "code_1",
      code_verifier: "verifier_1",
      redirect_uri: "http://127.0.0.1:53123/cb",
      client_id: "wbhk",
      resource: "https://api.webhook.co",
    });
  });

  it("maps an OAuth error result → 400 + {error}, redeem still consulted", async () => {
    const d = deps({
      redeemAuthCode: vi.fn(
        async (): Promise<RedeemResult> => ({
          kind: "error",
          error: "invalid_grant",
          description: "nope",
        }),
      ),
    });
    const res = await handleTokenRequest(d, form(AUTH_CODE_FIELDS));
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toEqual({ error: "invalid_grant", error_description: "nope" });
  });

  it("maps server_error → 500", async () => {
    const d = deps({
      redeemAuthCode: vi.fn(
        async (): Promise<RedeemResult> => ({ kind: "error", error: "server_error" }),
      ),
    });
    const res = await handleTokenRequest(d, form(AUTH_CODE_FIELDS));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "server_error" });
  });

  it("maps pending_approval → 400 authorization_pending (RFC 8628)", async () => {
    const d = deps({
      redeemAuthCode: vi.fn(
        async (): Promise<RedeemResult> => ({ kind: "pending", grantId: "g_1", interval: 5 }),
      ),
    });
    const res = await handleTokenRequest(d, form(AUTH_CODE_FIELDS));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "authorization_pending" });
  });

  it("rejects a code grant missing code or code_verifier as invalid_request, without calling redeem", async () => {
    const d = deps();
    const noCode = await handleTokenRequest(d, form({ ...AUTH_CODE_FIELDS, code: "" }));
    const noVerifier = await handleTokenRequest(
      d,
      form({ ...AUTH_CODE_FIELDS, code_verifier: "" }),
    );
    expect(noCode.status).toBe(400);
    expect(await noCode.json()).toMatchObject({ error: "invalid_request" });
    expect(noVerifier.status).toBe(400);
    expect(d.redeemAuthCode).not.toHaveBeenCalled();
  });
});

describe("handleTokenRequest — grant_type dispatch", () => {
  it("missing grant_type → unsupported_grant_type", async () => {
    const res = await handleTokenRequest(deps(), form({ code: "x" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unsupported_grant_type" });
  });

  it("unknown grant_type → unsupported_grant_type", async () => {
    const res = await handleTokenRequest(deps(), form({ grant_type: "password" }));
    expect(await res.json()).toMatchObject({ error: "unsupported_grant_type" });
  });

  it("refresh_token with no refresh core wired → unsupported_grant_type (A2b-3 wires it)", async () => {
    const res = await handleTokenRequest(
      deps(),
      form({ grant_type: "refresh_token", refresh_token: "rtk_x" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unsupported_grant_type" });
  });

  it("refresh_token WITH a refresh core wired → dispatches to it and returns its result", async () => {
    const redeemRefresh = vi.fn(
      async (): Promise<RedeemResult> => ({ kind: "token", body: FROZEN }),
    );
    const res = await handleTokenRequest(
      deps({ redeemRefresh }),
      form({ grant_type: "refresh_token", refresh_token: "rtk_x", scope: "events:read" }),
    );
    expect(res.status).toBe(200);
    expect(redeemRefresh).toHaveBeenCalledWith({
      grant_type: "refresh_token",
      refresh_token: "rtk_x",
      client_id: "",
      resource: "",
      scope: "events:read",
    });
  });

  it("refresh_token missing refresh_token → invalid_request", async () => {
    const redeemRefresh = vi.fn(
      async (): Promise<RedeemResult> => ({ kind: "token", body: FROZEN }),
    );
    const res = await handleTokenRequest(
      deps({ redeemRefresh }),
      form({ grant_type: "refresh_token" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
    expect(redeemRefresh).not.toHaveBeenCalled();
  });
});
