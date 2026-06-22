import { describe, expect, it, vi } from "vitest";

import {
  handleAuthorize,
  handleConsentComplete,
  handleConsentDecision,
  type AuthorizeRouteDeps,
} from "./authorize-route";
import type { ConsentAuthRequest } from "./consent-ticket";

// A3d — the pure HTTP contract of GET /authorize + POST /consent/decision. Parses the request, resolves the
// session, calls the (injected, already-tested) consent cores, and maps the result to a redirect / JSON
// response. I/O-free: the provider, session, DB, and crypto live behind the injected seams.

const AUTH_REQUEST: ConsentAuthRequest = {
  responseType: "code",
  clientId: "cli_wbhk",
  redirectUri: "http://127.0.0.1:51763/callback",
  scope: ["events:read"],
  state: "st_123",
  codeChallenge: "chal",
  codeChallengeMethod: "S256",
  resource: "https://api.webhook.co",
};

function routeDeps(over: Partial<AuthorizeRouteDeps> = {}): AuthorizeRouteDeps {
  return {
    parseAuthRequest: async () => AUTH_REQUEST,
    getSessionUserId: async () => "user_dana",
    resolveOrigin: () => ({ ip: "203.0.113.7", location: "US" }),
    loginUrl: (returnTo) => `/login?redirect=${encodeURIComponent(returnTo)}`,
    buildConsent: async () => ({ kind: "consent", location: "/consent?ticket=TICKET" }),
    decideConsent: async () => ({
      kind: "ok",
      redirectTo: "http://127.0.0.1:51763/callback?code=AC",
    }),
    // Fakes: seal embeds the URL verbatim (real impl signs it); open vouches a loopback ticket only.
    sealLoopbackRedirect: async (redirectTo) => `/consent/complete?c=${redirectTo}`,
    openLoopbackRedirect: async (ticket) => (ticket.startsWith("http://127.0.0.1") ? ticket : null),
    ...over,
  };
}

describe("handleAuthorize (GET /authorize)", () => {
  it("redirects to login (preserving the return URL) when there is no session", async () => {
    const deps = routeDeps({ getSessionUserId: async () => null });
    const req = new Request(
      "https://auth.webhook.co/authorize?response_type=code&client_id=cli_wbhk",
    );
    const res = await handleAuthorize(deps, req);
    expect(res.status).toBe(302);
    // The return URL is a RELATIVE path+query (no scheme/host) — so the value Lane E reflects can't be an
    // off-origin open redirect.
    expect(res.headers.get("location")).toBe(
      `/login?redirect=${encodeURIComponent("/authorize?response_type=code&client_id=cli_wbhk")}`,
    );
  });

  it("redirects to the consent screen carrying the ticket on a valid request", async () => {
    const res = await handleAuthorize(
      routeDeps(),
      new Request("https://auth.webhook.co/authorize"),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/consent?ticket=TICKET");
  });

  it("redirects to the client with the OAuth error for a recoverable error result", async () => {
    const deps = routeDeps({
      buildConsent: async () => ({
        kind: "redirect",
        location: "http://127.0.0.1:51763/callback?error=invalid_scope&state=st_123",
      }),
    });
    const res = await handleAuthorize(deps, new Request("https://auth.webhook.co/authorize"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "http://127.0.0.1:51763/callback?error=invalid_scope&state=st_123",
    );
  });

  it("returns 400 (no redirect) when the request itself is untrustworthy", async () => {
    const deps = routeDeps({
      buildConsent: async () => ({
        kind: "bad_request",
        error: "invalid_request",
        description: "redirect_uri is not permitted",
      }),
    });
    const res = await handleAuthorize(deps, new Request("https://auth.webhook.co/authorize"));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("returns 400 when the authorization request cannot be parsed", async () => {
    const deps = routeDeps({
      parseAuthRequest: async () => {
        throw new Error("unknown client");
      },
    });
    const res = await handleAuthorize(deps, new Request("https://auth.webhook.co/authorize"));
    expect(res.status).toBe(400);
  });

  it("passes the parsed request, session user, and origin into buildConsent", async () => {
    const build = vi.fn(async () => ({ kind: "consent" as const, location: "/consent?ticket=T" }));
    const deps = routeDeps({ buildConsent: build });
    await handleAuthorize(deps, new Request("https://auth.webhook.co/authorize"));
    expect(build).toHaveBeenCalledWith(AUTH_REQUEST, "user_dana", {
      ip: "203.0.113.7",
      location: "US",
    });
  });
});

function decisionRequest(body: unknown, contentType = "application/json"): Request {
  return new Request("https://auth.webhook.co/consent/decision", {
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("handleConsentDecision (POST /consent/decision)", () => {
  it("wraps the absolute loopback redirect into a SAME-ORIGIN /consent/complete bounce", async () => {
    // The browser can't client-side navigate https://auth → http://127.0.0.1 (Private Network Access), so
    // the decision returns a same-origin bounce; GET /consent/complete then 302s to the loopback server-side.
    const seal = vi.fn(async (r: string) => `/consent/complete?c=${r}`);
    const res = await handleConsentDecision(
      routeDeps({ sealLoopbackRedirect: seal }),
      decisionRequest({ requestId: "TICKET", csrfToken: "csrf", decision: "approve" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = (await res.json()) as { redirectTo: string };
    expect(body.redirectTo.startsWith("/consent/complete?c=")).toBe(true);
    expect(seal).toHaveBeenCalledWith("http://127.0.0.1:51763/callback?code=AC");
  });

  it("returns a relative (device) redirect unchanged — no bounce for a same-origin target", async () => {
    const seal = vi.fn();
    const res = await handleConsentDecision(
      routeDeps({
        decideConsent: async () => ({ kind: "ok", redirectTo: "/device?status=approved" }),
        sealLoopbackRedirect: seal,
      }),
      decisionRequest({ requestId: "TICKET", csrfToken: "csrf", decision: "approve" }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ redirectTo: "/device?status=approved" });
    expect(seal).not.toHaveBeenCalled();
  });

  it("resolves the session user from the request, not the body", async () => {
    const decide = vi.fn(async () => ({ kind: "ok" as const, redirectTo: "x" }));
    const deps = routeDeps({ getSessionUserId: async () => "user_real", decideConsent: decide });
    await handleConsentDecision(
      deps,
      // an attacker-supplied userId in the body must be ignored.
      decisionRequest({
        requestId: "TICKET",
        csrfToken: "csrf",
        decision: "deny",
        userId: "user_attacker",
      }),
    );
    expect(decide).toHaveBeenCalledWith({
      requestId: "TICKET",
      csrfToken: "csrf",
      decision: "deny",
      sessionUserId: "user_real",
    });
  });

  it("bounces a deny's access_denied loopback redirect through the same-origin complete path too", async () => {
    const seal = vi.fn(async (r: string) => `/consent/complete?c=${r}`);
    const deps = routeDeps({
      decideConsent: async () => ({
        kind: "ok",
        redirectTo: "http://127.0.0.1:51763/callback?error=access_denied&state=st_123",
      }),
      sealLoopbackRedirect: seal,
    });
    const res = await handleConsentDecision(
      deps,
      decisionRequest({ requestId: "TICKET", csrfToken: "csrf", decision: "deny" }),
    );
    expect(res.status).toBe(200);
    expect(seal).toHaveBeenCalledWith(
      "http://127.0.0.1:51763/callback?error=access_denied&state=st_123",
    );
    expect(((await res.json()) as { redirectTo: string }).redirectTo).toMatch(
      /^\/consent\/complete\?c=/,
    );
  });

  it("maps a decision error to its status + OAuth error body", async () => {
    const deps = routeDeps({
      decideConsent: async () => ({
        kind: "error",
        status: 403,
        error: "access_denied",
        description: "session mismatch",
      }),
    });
    const res = await handleConsentDecision(
      deps,
      decisionRequest({ requestId: "TICKET", csrfToken: "csrf", decision: "approve" }),
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: "access_denied",
      error_description: "session mismatch",
    });
  });

  it("rejects a non-JSON content type (CSRF hardening) with 415", async () => {
    const res = await handleConsentDecision(
      routeDeps(),
      decisionRequest("requestId=TICKET&decision=approve", "application/x-www-form-urlencoded"),
    );
    expect(res.status).toBe(415);
  });

  it("is not fooled by a content type that merely contains application/json (MIME parsed, not substring)", async () => {
    // A CORS-safelisted multipart MIME whose boundary contains "application/json" must still be rejected.
    const res = await handleConsentDecision(
      routeDeps(),
      decisionRequest(
        JSON.stringify({ requestId: "TICKET", csrfToken: "csrf", decision: "approve" }),
        "multipart/form-data; boundary=----application/json",
      ),
    );
    expect(res.status).toBe(415);
  });

  it("returns 400 for an unparseable body or a schema-invalid decision", async () => {
    const garbage = await handleConsentDecision(routeDeps(), decisionRequest("not json"));
    expect(garbage.status).toBe(400);
    const badDecision = await handleConsentDecision(
      routeDeps(),
      decisionRequest({ requestId: "TICKET", csrfToken: "csrf", decision: "maybe" }),
    );
    expect(badDecision.status).toBe(400);
    const missing = await handleConsentDecision(
      routeDeps(),
      decisionRequest({ requestId: "", csrfToken: "csrf", decision: "approve" }),
    );
    expect(missing.status).toBe(400);
  });

  it("does not call decideConsent when the body is invalid", async () => {
    const decide = vi.fn(async () => ({ kind: "ok" as const, redirectTo: "x" }));
    await handleConsentDecision(routeDeps({ decideConsent: decide }), decisionRequest("not json"));
    expect(decide).not.toHaveBeenCalled();
  });
});

describe("handleConsentComplete (GET /consent/complete)", () => {
  const completeRequest = (c?: string) =>
    new Request(
      `https://auth.webhook.co/consent/complete${
        c === undefined ? "" : `?c=${encodeURIComponent(c)}`
      }`,
    );

  it("302s the browser to the loopback callback for a valid completion ticket", async () => {
    const res = await handleConsentComplete(
      routeDeps(),
      completeRequest("http://127.0.0.1:51763/callback?code=AC"),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://127.0.0.1:51763/callback?code=AC");
  });

  it("400s when the completion ticket is missing", async () => {
    const res = await handleConsentComplete(routeDeps(), completeRequest());
    expect(res.status).toBe(400);
  });

  it("400s (never redirects) when the completion ticket is invalid/expired/non-loopback", async () => {
    // open returns null → no redirect, so a forged/expired ticket can't drive an open redirect.
    const res = await handleConsentComplete(routeDeps(), completeRequest("https://evil.example/x"));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });
});
