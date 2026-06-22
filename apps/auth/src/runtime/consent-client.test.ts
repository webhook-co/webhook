import { describe, expect, it, vi } from "vitest";

import { ConsentDecisionError } from "@/app/(auth)/consent/consent-form";

import { makeConsentActions, makeDeviceActions } from "./consent-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("makeConsentActions", () => {
  it("POSTs the decision and navigates to redirectTo on success", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ redirectTo: "https://client/cb?code=abc" }));
    const navigate = vi.fn();
    const actions = makeConsentActions(
      { requestId: "tkt_123", csrfToken: "csrf_xyz" },
      { fetch: fetchImpl, navigate },
    );

    await actions.decide("approve");

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/consent/decision");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(init?.body as string)).toEqual({
      requestId: "tkt_123",
      csrfToken: "csrf_xyz",
      decision: "approve",
    });
    expect(navigate).toHaveBeenCalledWith("https://client/cb?code=abc");
  });

  it("sends decision:deny", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ redirectTo: "https://client/cb?error=access_denied" }),
    );
    const navigate = vi.fn();
    await makeConsentActions(
      { requestId: "t", csrfToken: "c" },
      { fetch: fetchImpl, navigate },
    ).decide("deny");
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string).decision).toBe("deny");
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("throws a generic error and does not navigate on a 5xx", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "server_error" }, 500));
    const navigate = vi.fn();
    const actions = makeConsentActions(
      { requestId: "t", csrfToken: "c" },
      { fetch: fetchImpl, navigate },
    );
    const err = await actions.decide("approve").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ConsentDecisionError);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("maps a 409 to ConsentDecisionError('already_decided') and does not navigate", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "already_decided" }, 409));
    const navigate = vi.fn();
    const actions = makeConsentActions(
      { requestId: "t", csrfToken: "c" },
      { fetch: fetchImpl, navigate },
    );
    const err = await actions.decide("approve").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConsentDecisionError);
    expect((err as ConsentDecisionError).reason).toBe("already_decided");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("maps a 400 to ConsentDecisionError('expired') and does not navigate", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "invalid_request" }, 400));
    const navigate = vi.fn();
    const actions = makeConsentActions(
      { requestId: "t", csrfToken: "c" },
      { fetch: fetchImpl, navigate },
    );
    const err = await actions.decide("deny").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConsentDecisionError);
    expect((err as ConsentDecisionError).reason).toBe("expired");
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("makeDeviceActions", () => {
  it("POSTs the user-code and navigates to redirectTo on success", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ redirectTo: "/consent?ticket=abc" }));
    const navigate = vi.fn();
    await makeDeviceActions({ fetch: fetchImpl, navigate }).verifyCode("WXYZ-1234");

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/device/verify");
    expect(JSON.parse(init?.body as string)).toEqual({ userCode: "WXYZ-1234" });
    expect(navigate).toHaveBeenCalledWith("/consent?ticket=abc");
  });

  it("navigates to login_url on 401 (not signed in)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "login_required", login_url: "/login?x=1" }, 401),
    );
    const navigate = vi.fn();
    await makeDeviceActions({ fetch: fetchImpl, navigate }).verifyCode("WXYZ-1234");
    expect(navigate).toHaveBeenCalledWith("/login?x=1");
  });

  it("throws on a rate-limit / invalid code (so the form shows the error)", async () => {
    const navigate = vi.fn();
    const limited = makeDeviceActions({
      fetch: vi.fn(async () => jsonResponse({ error: "slow_down" }, 429)),
      navigate,
    });
    await expect(limited.verifyCode("WXYZ-1234")).rejects.toThrow();

    const bad = makeDeviceActions({
      fetch: vi.fn(async () => jsonResponse({ error: "invalid_request" }, 400)),
      navigate,
    });
    await expect(bad.verifyCode("WXYZ-1234")).rejects.toThrow();
    expect(navigate).not.toHaveBeenCalled();
  });
});
