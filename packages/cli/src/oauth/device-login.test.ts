import { describe, expect, it } from "vitest";

import { OAuthError } from "../errors.js";
import { deviceLogin } from "./device-login.js";

const AUTH_BASE = "https://auth.webhook.co";
const DEVICE_AUTH = {
  device_code: "dev_code_1",
  user_code: "WXYZ-1234",
  verification_uri: "https://auth.webhook.co/device",
  verification_uri_complete: "https://auth.webhook.co/device?user_code=WXYZ-1234",
  expires_in: 900,
  interval: 5,
};
const TOKEN = {
  access_token: "whk_access",
  token_type: "Bearer",
  expires_in: 86400,
  refresh_token: "rtk_refresh",
  scope: "events:read",
  resource: "https://api.webhook.co",
};
const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A fetch that returns DEVICE_AUTH for the device-authorization call and then walks a sequence of
 * responses for the /token poll calls (one per poll).
 */
function deviceFetch(pollSteps: ReadonlyArray<Response>): {
  fetch: typeof fetch;
  deviceCalls: () => number;
  pollCalls: () => number;
  pollBodies: () => URLSearchParams[];
} {
  let deviceCalls = 0;
  let pollIdx = 0;
  const pollBodies: URLSearchParams[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/device_authorization")) {
      deviceCalls += 1;
      return jsonRes(DEVICE_AUTH);
    }
    pollBodies.push(new URLSearchParams(String(init?.body)));
    const step = pollSteps[Math.min(pollIdx, pollSteps.length - 1)];
    pollIdx += 1;
    return step;
  }) as unknown as typeof fetch;
  return {
    fetch,
    deviceCalls: () => deviceCalls,
    pollCalls: () => pollIdx,
    pollBodies: () => pollBodies,
  };
}

const baseDeps = (fetch: typeof fetch, over: Record<string, unknown> = {}) => ({
  fetch,
  authBaseUrl: AUTH_BASE,
  clientId: "client_abc",
  scope: "events:read events:replay",
  resource: "https://api.webhook.co",
  sleep: async (_ms: number) => {},
  emit: () => {},
  ...over,
});

describe("deviceLogin", () => {
  it("requests a device code, shows the user code, and returns the token on approval", async () => {
    const lines: string[] = [];
    const f = deviceFetch([jsonRes(TOKEN)]);
    const body = await deviceLogin(baseDeps(f.fetch, { emit: (l: string) => lines.push(l) }));
    expect(body).toEqual(TOKEN);
    expect(f.deviceCalls()).toBe(1);
    // The user-facing instructions surface the verification URL + the user code.
    const out = lines.join("");
    expect(out).toContain("WXYZ-1234");
    expect(out).toContain("https://auth.webhook.co/device");
  });

  it("sends the device-code grant with the device_code + client_id on each poll", async () => {
    const f = deviceFetch([jsonRes(TOKEN)]);
    await deviceLogin(baseDeps(f.fetch));
    const sent = f.pollBodies()[0];
    expect(sent.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(sent.get("device_code")).toBe("dev_code_1");
    expect(sent.get("client_id")).toBe("client_abc");
  });

  it("keeps polling through authorization_pending until the token arrives", async () => {
    const f = deviceFetch([
      jsonRes({ error: "authorization_pending" }, 400),
      jsonRes({ error: "authorization_pending" }, 400),
      jsonRes(TOKEN),
    ]);
    const body = await deviceLogin(baseDeps(f.fetch));
    expect(body).toEqual(TOKEN);
    expect(f.pollCalls()).toBe(3);
  });

  it("backs off the poll interval by +5s on slow_down (RFC 8628 §3.5)", async () => {
    const slept: number[] = [];
    const f = deviceFetch([jsonRes({ error: "slow_down" }, 400), jsonRes(TOKEN)]);
    await deviceLogin(baseDeps(f.fetch, { sleep: async (ms: number) => void slept.push(ms) }));
    // First wait = interval (5s); after slow_down the next wait is interval + 5s = 10s.
    expect(slept).toEqual([5000, 10000]);
  });

  it("opens the browser (best-effort) to the complete verification URL", async () => {
    let opened: string | null = null;
    const f = deviceFetch([jsonRes(TOKEN)]);
    await deviceLogin(baseDeps(f.fetch, { openBrowser: async (u: string) => void (opened = u) }));
    expect(opened).toBe("https://auth.webhook.co/device?user_code=WXYZ-1234");
  });

  it("does NOT auto-open a cross-origin verification URL (a hostile issuer)", async () => {
    let opened: string | null = null;
    const fetch = (async (url: string) => {
      if (String(url).endsWith("/device_authorization")) {
        return jsonRes({
          ...DEVICE_AUTH,
          verification_uri: "https://evil.example/device",
          verification_uri_complete: "https://evil.example/device?user_code=WXYZ-1234",
        });
      }
      return jsonRes(TOKEN);
    }) as unknown as typeof fetch;
    const body = await deviceLogin(
      baseDeps(fetch, { openBrowser: async (u: string) => void (opened = u) }),
    );
    expect(body).toEqual(TOKEN); // the flow still completes
    expect(opened).toBeNull(); // but the off-issuer URL is print-only, never auto-opened
  });

  it("does NOT auto-open an unparseable verification URL", async () => {
    let opened: string | null = null;
    const fetch = (async (url: string) => {
      if (String(url).endsWith("/device_authorization")) {
        return jsonRes({ ...DEVICE_AUTH, verification_uri_complete: "not a url" });
      }
      return jsonRes(TOKEN);
    }) as unknown as typeof fetch;
    await deviceLogin(baseDeps(fetch, { openBrowser: async (u: string) => void (opened = u) }));
    expect(opened).toBeNull();
  });

  it("strips terminal-control bytes from the emitted verification URL + user code", async () => {
    const ESC = String.fromCharCode(27);
    const lines: string[] = [];
    const fetch = (async (url: string) => {
      if (String(url).endsWith("/device_authorization")) {
        return jsonRes({
          ...DEVICE_AUTH,
          verification_uri: `https://auth.webhook.co/device${ESC}[2K`,
          user_code: `WXYZ${ESC}[31m-1234`,
        });
      }
      return jsonRes(TOKEN);
    }) as unknown as typeof fetch;
    await deviceLogin(baseDeps(fetch, { emit: (l: string) => lines.push(l) }));
    expect(lines.join("")).not.toContain(ESC);
  });

  it("opens the plain verification_uri when no complete URL is provided", async () => {
    // A device-authorization response without verification_uri_complete (RFC 8628 makes it optional).
    let opened: string | null = null;
    const fetch = (async (url: string) => {
      if (String(url).endsWith("/device_authorization")) {
        const { verification_uri_complete: _omit, ...withoutComplete } = DEVICE_AUTH;
        return jsonRes(withoutComplete);
      }
      return jsonRes(TOKEN);
    }) as unknown as typeof fetch;
    await deviceLogin(baseDeps(fetch, { openBrowser: async (u: string) => void (opened = u) }));
    expect(opened).toBe("https://auth.webhook.co/device"); // the plain verification_uri
  });

  it("does not fail if opening the browser throws (best-effort)", async () => {
    const f = deviceFetch([jsonRes(TOKEN)]);
    const body = await deviceLogin(
      baseDeps(f.fetch, {
        openBrowser: async () => {
          throw new Error("no browser");
        },
      }),
    );
    expect(body).toEqual(TOKEN);
  });

  it("maps access_denied (user declined) to an OAuthError", async () => {
    const f = deviceFetch([jsonRes({ error: "access_denied" }, 400)]);
    await expect(deviceLogin(baseDeps(f.fetch))).rejects.toMatchObject({ code: "access_denied" });
  });

  it("maps expired_token (the device code lapsed) to an OAuthError", async () => {
    const f = deviceFetch([jsonRes({ error: "expired_token" }, 400)]);
    await expect(deviceLogin(baseDeps(f.fetch))).rejects.toMatchObject({ code: "expired_token" });
  });

  it("stops with expired_token once the device-code deadline passes (client-side)", async () => {
    const f = deviceFetch([jsonRes({ error: "authorization_pending" }, 400)]);
    // now() jumps past start + expires_in*1000 on the second read (after the first sleep).
    let n = 0;
    const now = (): number => (n++ === 0 ? 1_000_000 : 1_000_000 + 900_000 + 1);
    await expect(deviceLogin(baseDeps(f.fetch, { now }))).rejects.toBeInstanceOf(OAuthError);
  });

  it("propagates an unexpected poll error as an OAuthError", async () => {
    const f = deviceFetch([jsonRes({ error: "invalid_client" }, 400)]);
    await expect(deviceLogin(baseDeps(f.fetch))).rejects.toMatchObject({ code: "invalid_client" });
  });
});
