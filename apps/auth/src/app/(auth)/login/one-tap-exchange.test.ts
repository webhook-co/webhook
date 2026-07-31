import { describe, expect, it, vi } from "vitest";

import { ONE_TAP_ERROR, exchangeOneTapCredential } from "./one-tap-exchange";

// The credential-for-session exchange, kept pure so the security-relevant half of One Tap is testable
// without a browser: what we POST, what we do with each response, and — above all — where we are willing
// to send the browser afterwards.

const ok = (body: unknown = { token: "t" }) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

const status = (code: number, body: unknown = {}) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: code }));

describe("exchangeOneTapCredential — the request", () => {
  it("POSTs the credential and the callbackURL to the one-tap endpoint", async () => {
    const fetchFn = ok();
    await exchangeOneTapCredential(
      { credential: "id-token-abc", callbackURL: "/session/handoff" },
      fetchFn,
    );

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auth/one-tap/callback");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      idToken: "id-token-abc",
      callbackURL: "/session/handoff",
    });
  });

  // The whole point of the exchange is the Set-Cookie it returns. A fetch that drops cookies signs
  // nobody in, and the failure is invisible: a 200 with no session.
  it("sends same-origin credentials so the session cookie is actually stored", async () => {
    const fetchFn = ok();
    await exchangeOneTapCredential({ credential: "x", callbackURL: "/y" }, fetchFn);
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBe("same-origin");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });
});

describe("exchangeOneTapCredential — outcomes", () => {
  it("reports signed-in with the redirect target on 200", async () => {
    const res = await exchangeOneTapCredential(
      { credential: "x", callbackURL: "/session/handoff" },
      ok(),
    );
    expect(res).toEqual({ status: "signed-in", target: "/session/handoff" });
  });

  // The user actively tapped and confirmed. Silence here is the "clicking does nothing" bug, so this is
  // the one One Tap failure that must reach the screen.
  it.each([400, 401, 403, 415, 429, 500, 503])("reports rejected on %i", async (code) => {
    const res = await exchangeOneTapCredential(
      { credential: "x", callbackURL: "/y" },
      status(code),
    );
    expect(res).toEqual({ status: "rejected", message: ONE_TAP_ERROR });
  });

  it("reports rejected when the network call throws", async () => {
    const res = await exchangeOneTapCredential(
      { credential: "x", callbackURL: "/y" },
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    expect(res).toEqual({ status: "rejected", message: ONE_TAP_ERROR });
  });

  // The endpoint answers a missing email with a 200 carrying an error body rather than a 4xx. Treating
  // status alone as success would redirect a user who was never signed in, straight into a bounce.
  it("reports rejected on a 200 that carries an error body", async () => {
    const res = await exchangeOneTapCredential(
      { credential: "x", callbackURL: "/y" },
      ok({ error: "Email not available in token" }),
    );
    expect(res).toEqual({ status: "rejected", message: ONE_TAP_ERROR });
  });

  it("reports rejected when the response is not JSON at all", async () => {
    const res = await exchangeOneTapCredential(
      { credential: "x", callbackURL: "/y" },
      vi.fn(async () => new Response("<html>gateway</html>", { status: 200 })),
    );
    expect(res).toEqual({ status: "rejected", message: ONE_TAP_ERROR });
  });
});

// DEFENCE IN DEPTH. `callbackURL` is produced by resolvePostLoginTarget, which already guards it, and the
// server now re-validates it against trustedOrigins. This is the third check, and it is the one that sits
// immediately before `window.location` — the only place that actually navigates. It costs one call and it
// removes the possibility that a future refactor upstream turns this into an open redirect.
describe("exchangeOneTapCredential — redirect target", () => {
  it.each([
    ["absolute off-origin", "https://evil.example/steal"],
    ["protocol-relative", "//evil.example/steal"],
    ["backslash escape", "/\\evil.example"],
    ["encoded slash escape", "/%2f%2fevil.example"],
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", "data:text/html,<script>1</script>"],
  ])("refuses to navigate to %s — falls back to the handoff", async (_label, target) => {
    const res = await exchangeOneTapCredential({ credential: "x", callbackURL: target }, ok());
    expect(res).toEqual({ status: "signed-in", target: "/session/handoff" });
  });

  it("keeps a legitimate same-origin path", async () => {
    const res = await exchangeOneTapCredential(
      { credential: "x", callbackURL: "/consent?foo=1" },
      ok(),
    );
    expect(res).toEqual({ status: "signed-in", target: "/consent?foo=1" });
  });

  // Sending a just-authenticated user back to the login form is the redirect loop post-login-target.tsx
  // exists to prevent; the guard has to hold on this path too.
  it("never navigates back to /login", async () => {
    const res = await exchangeOneTapCredential({ credential: "x", callbackURL: "/login" }, ok());
    expect(res).toEqual({ status: "signed-in", target: "/session/handoff" });
  });
});
