import { describe, expect, it } from "vitest";

import { OAuthError } from "../errors.js";
import { pollDeviceToken, requestDeviceAuthorization } from "./device.js";

const DEVICE_AUTH = {
  device_code: "dev_code_1",
  user_code: "WXYZ-1234",
  verification_uri: "https://auth.webhook.co/device",
  verification_uri_complete: "https://auth.webhook.co/device?user_code=WXYZ-1234",
  expires_in: 900,
  interval: 5,
};
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

describe("requestDeviceAuthorization", () => {
  it("POSTs the form (client_id/scope/resource) and parses the device authorization", async () => {
    const rec = recordingFetch(jsonRes(DEVICE_AUTH));
    const auth = await requestDeviceAuthorization(
      { fetch: rec.fetch },
      "https://auth.webhook.co/device_authorization",
      { clientId: "client_xyz", scope: "events:read", resource: "https://api.webhook.co" },
    );
    expect(auth).toEqual(DEVICE_AUTH);
    const sent = rec.body();
    expect(sent.get("client_id")).toBe("client_xyz");
    expect(sent.get("scope")).toBe("events:read");
    expect(sent.get("resource")).toBe("https://api.webhook.co");
  });

  it("maps a 400 {error} to an OAuthError carrying the code", async () => {
    const rec = recordingFetch(jsonRes({ error: "invalid_request" }, 400));
    await expect(
      requestDeviceAuthorization(
        { fetch: rec.fetch },
        "https://auth.webhook.co/device_authorization",
        {
          clientId: "c",
          scope: "events:read",
          resource: "https://api.webhook.co",
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("rejects a malformed (non-DeviceAuthorization) success response", async () => {
    const rec = recordingFetch(jsonRes({ device_code: "x" })); // missing fields
    await expect(
      requestDeviceAuthorization(
        { fetch: rec.fetch },
        "https://auth.webhook.co/device_authorization",
        {
          clientId: "c",
          scope: "events:read",
          resource: "https://api.webhook.co",
        },
      ),
    ).rejects.toBeInstanceOf(OAuthError);
  });
});

describe("pollDeviceToken", () => {
  const poll = (res: Response) =>
    pollDeviceToken({ fetch: recordingFetch(res).fetch }, "https://auth.webhook.co/token", {
      deviceCode: "dev_code_1",
      clientId: "client_xyz",
    });

  it("POSTs the device-code grant (form)", async () => {
    const rec = recordingFetch(jsonRes(FROZEN));
    await pollDeviceToken({ fetch: rec.fetch }, "https://auth.webhook.co/token", {
      deviceCode: "dev_code_1",
      clientId: "client_xyz",
    });
    const sent = rec.body();
    expect(sent.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(sent.get("device_code")).toBe("dev_code_1");
    expect(sent.get("client_id")).toBe("client_xyz");
  });

  it("returns the token body on success", async () => {
    const res = await poll(jsonRes(FROZEN));
    expect(res).toEqual({ kind: "token", body: FROZEN });
  });

  it("maps authorization_pending → pending (keep polling)", async () => {
    expect(await poll(jsonRes({ error: "authorization_pending" }, 400))).toEqual({
      kind: "pending",
    });
  });

  it("maps slow_down → slow_down (back off then keep polling)", async () => {
    expect(await poll(jsonRes({ error: "slow_down" }, 400))).toEqual({ kind: "slow_down" });
  });

  it("maps access_denied → denied (terminal)", async () => {
    expect(await poll(jsonRes({ error: "access_denied" }, 400))).toEqual({ kind: "denied" });
  });

  it("maps expired_token → expired (terminal)", async () => {
    expect(await poll(jsonRes({ error: "expired_token" }, 400))).toEqual({ kind: "expired" });
  });

  it("throws OAuthError for any other error code", async () => {
    await expect(poll(jsonRes({ error: "invalid_client" }, 400))).rejects.toMatchObject({
      code: "invalid_client",
    });
  });

  it("throws OAuthError on a malformed success body", async () => {
    await expect(poll(jsonRes({ access_token: "whk_x" }))).rejects.toBeInstanceOf(OAuthError);
  });
});
