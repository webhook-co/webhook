import { describe, expect, it } from "vitest";

import { OAuthError } from "../errors.js";
import { exchangeAuthCode, refreshAccessToken, toOAuthCredential } from "./token-client.js";

const FROZEN = {
  access_token: "whk_access",
  token_type: "Bearer",
  expires_in: 86400,
  refresh_token: "rtk_refresh",
  scope: "events:read events:replay",
  resource: "https://api.webhook.co",
};
const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch that records the request + returns a fixed response. */
function recordingFetch(res: Response): {
  fetch: typeof fetch;
  body: () => URLSearchParams;
  url: () => string;
} {
  let captured: { url: string; body: string } = { url: "", body: "" };
  const f = (async (url: string, init?: RequestInit) => {
    captured = { url, body: String(init?.body) };
    return res;
  }) as unknown as typeof fetch;
  return { fetch: f, body: () => new URLSearchParams(captured.body), url: () => captured.url };
}

describe("exchangeAuthCode", () => {
  it("POSTs the authorization_code grant (form) and parses the FrozenTokenBody", async () => {
    const rec = recordingFetch(jsonRes(FROZEN));
    const body = await exchangeAuthCode({ fetch: rec.fetch }, "https://auth.webhook.co/token", {
      code: "code_1",
      codeVerifier: "verifier_1",
      redirectUri: "http://127.0.0.1:51000/callback",
      clientId: "client_xyz",
      resource: "https://api.webhook.co",
    });
    expect(body).toEqual(FROZEN);
    const sent = rec.body();
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code")).toBe("code_1");
    expect(sent.get("code_verifier")).toBe("verifier_1");
    expect(sent.get("redirect_uri")).toBe("http://127.0.0.1:51000/callback");
    expect(sent.get("client_id")).toBe("client_xyz");
    expect(sent.get("resource")).toBe("https://api.webhook.co");
  });

  it("maps a 400 {error} to an OAuthError carrying the code", async () => {
    const rec = recordingFetch(jsonRes({ error: "invalid_grant" }, 400));
    await expect(
      exchangeAuthCode({ fetch: rec.fetch }, "https://auth.webhook.co/token", {
        code: "x",
        codeVerifier: "y",
        redirectUri: "http://127.0.0.1/cb",
        clientId: "c",
        resource: "https://api.webhook.co",
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("rejects a malformed (non-FrozenTokenBody) success response", async () => {
    const rec = recordingFetch(jsonRes({ access_token: "whk_x" })); // missing fields
    await expect(
      exchangeAuthCode({ fetch: rec.fetch }, "https://auth.webhook.co/token", {
        code: "x",
        codeVerifier: "y",
        redirectUri: "http://127.0.0.1/cb",
        clientId: "c",
        resource: "https://api.webhook.co",
      }),
    ).rejects.toBeInstanceOf(OAuthError);
  });
});

describe("refreshAccessToken", () => {
  it("POSTs the refresh_token grant (form) and returns the rotated FrozenTokenBody", async () => {
    const rotated = { ...FROZEN, access_token: "whk_new", refresh_token: "rtk_new" };
    const rec = recordingFetch(jsonRes(rotated));
    const body = await refreshAccessToken({ fetch: rec.fetch }, "https://auth.webhook.co/token", {
      refreshToken: "rtk_old",
      clientId: "client_xyz",
      resource: "https://api.webhook.co",
    });
    expect(body.refresh_token).toBe("rtk_new"); // rotated
    const sent = rec.body();
    expect(sent.get("grant_type")).toBe("refresh_token");
    expect(sent.get("refresh_token")).toBe("rtk_old");
  });

  it("surfaces invalid_grant (a consumed/expired refresh) as an OAuthError → re-login", async () => {
    const rec = recordingFetch(jsonRes({ error: "invalid_grant" }, 400));
    await expect(
      refreshAccessToken({ fetch: rec.fetch }, "https://auth.webhook.co/token", {
        refreshToken: "rtk_dead",
        clientId: "c",
        resource: "https://api.webhook.co",
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });
});

describe("toOAuthCredential", () => {
  it("synthesizes the CLI-side fields (expiresAt, audience, authMethod, clientId)", () => {
    const now = 1_700_000_000_000;
    const cred = toOAuthCredential(FROZEN, { authMethod: "loopback", clientId: "client_xyz", now });
    expect(cred.oauth).toEqual({
      accessKey: "whk_access",
      refreshToken: "rtk_refresh",
      authMethod: "loopback",
      expiresAt: now + 86400 * 1000,
      audience: "https://api.webhook.co",
      clientId: "client_xyz",
    });
  });
});
