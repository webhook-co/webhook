import { describe, expect, it, vi } from "vitest";

import { handleDeviceVerify, type DeviceVerifyRouteDeps } from "./device-verify-route";

// A4c-3 — POST /device/verify (the device browser approval entry). Parse the user-code, rate-limit the
// guess surface, require an authed session, resolve the pending device record, and build the consent ticket
// → redirect to the shared /consent screen. I/O-free (session, rate-limit, store, consent core injected).

const ORIGIN = { ip: "203.0.113.7", location: "US" };

function deps(over: Partial<DeviceVerifyRouteDeps> = {}): DeviceVerifyRouteDeps {
  return {
    getSessionUserId: async () => "user_dana",
    resolveOrigin: () => ORIGIN,
    rateLimitBucket: (userId) => `device-verify:user:${userId}`,
    rateLimit: async () => ({
      allowed: true,
      remaining: 9,
      retryAfterSeconds: 0,
      resetSeconds: 60,
    }),
    loginUrl: (returnTo) => `/login?redirect=${encodeURIComponent(returnTo)}`,
    findDeviceRecord: async () => ({
      userCode: "WXYZ-1234",
      clientId: "cli_wbhk",
      scopes: ["events:read"],
      audience: "https://api.webhook.co",
    }),
    buildDeviceConsent: async () => ({ kind: "consent", location: "/consent?ticket=TICKET" }),
    ...over,
  };
}

function jsonReq(body: unknown, contentType = "application/json"): Request {
  return new Request("https://auth.webhook.co/device/verify", {
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("handleDeviceVerify", () => {
  it("redirects to the consent screen on a valid user-code + session", async () => {
    const res = await handleDeviceVerify(deps(), jsonReq({ userCode: "wxyz-1234" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    await expect(res.json()).resolves.toEqual({ redirectTo: "/consent?ticket=TICKET" });
  });

  it("rejects a non-JSON content type with 415 (CSRF hardening)", async () => {
    const res = await handleDeviceVerify(
      deps(),
      jsonReq("userCode=WXYZ-1234", "application/x-www-form-urlencoded"),
    );
    expect(res.status).toBe(415);
  });

  it("returns 401 + a login URL when there is no session (no store/rate-limit touched)", async () => {
    const rateLimit = vi.fn(deps().rateLimit);
    const findDeviceRecord = vi.fn(deps().findDeviceRecord);
    const res = await handleDeviceVerify(
      deps({ getSessionUserId: async () => null, rateLimit, findDeviceRecord }),
      jsonReq({ userCode: "WXYZ-1234" }),
    );
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: "login_required" });
    expect(rateLimit).not.toHaveBeenCalled();
    expect(findDeviceRecord).not.toHaveBeenCalled();
  });

  it("rate-limits by the SESSION principal (not the user-code) and 429s when over budget", async () => {
    const rateLimit = vi.fn(async () => ({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 42,
      resetSeconds: 42,
    }));
    const findDeviceRecord = vi.fn(deps().findDeviceRecord);
    const res = await handleDeviceVerify(
      deps({ rateLimit, findDeviceRecord }),
      jsonReq({ userCode: "WXYZ-1234" }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(rateLimit).toHaveBeenCalledWith("device-verify:user:user_dana");
    // the code is never looked up when rate-limited — no guess is processed.
    expect(findDeviceRecord).not.toHaveBeenCalled();
  });

  it("fails closed (503) when the rate limiter itself errors — never an open guessing window", async () => {
    const findDeviceRecord = vi.fn(deps().findDeviceRecord);
    const res = await handleDeviceVerify(
      deps({
        rateLimit: async () => {
          throw new Error("kv down");
        },
        findDeviceRecord,
      }),
      jsonReq({ userCode: "WXYZ-1234" }),
    );
    expect(res.status).toBe(503);
    expect(findDeviceRecord).not.toHaveBeenCalled();
  });

  it("returns 400 for a missing user-code (rate-limit not consumed)", async () => {
    const rateLimit = vi.fn(deps().rateLimit);
    const res = await handleDeviceVerify(deps({ rateLimit }), jsonReq({ nope: "x" }));
    expect(res.status).toBe(400);
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("returns 400 for an unknown/expired user-code (anti-enumeration, generic message)", async () => {
    const res = await handleDeviceVerify(
      deps({ findDeviceRecord: async () => null }),
      jsonReq({ userCode: "WXYZ-1234" }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_request" });
  });

  it("passes the resolved record + session user + origin into buildDeviceConsent", async () => {
    const build = vi.fn(async () => ({ kind: "consent" as const, location: "/consent?ticket=T" }));
    await handleDeviceVerify(
      deps({ buildDeviceConsent: build }),
      jsonReq({ userCode: "WXYZ-1234" }),
    );
    expect(build).toHaveBeenCalledWith(
      {
        userCode: "WXYZ-1234",
        clientId: "cli_wbhk",
        scopes: ["events:read"],
        audience: "https://api.webhook.co",
      },
      "user_dana",
      ORIGIN,
    );
  });

  it("maps a buildDeviceConsent error to its status + body", async () => {
    const res = await handleDeviceVerify(
      deps({
        buildDeviceConsent: async () => ({
          kind: "error",
          status: 400,
          error: "invalid_scope",
          description: "no permitted scope",
        }),
      }),
      jsonReq({ userCode: "WXYZ-1234" }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_scope" });
  });
});
