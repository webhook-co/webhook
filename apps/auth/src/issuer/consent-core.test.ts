import { describe, expect, it, vi } from "vitest";

import {
  buildConsent,
  buildDeviceConsent,
  decideConsent,
  type BuildConsentDeps,
  type BuildDeviceConsentDeps,
  type DecideConsentDeps,
} from "./consent-core";
import type { ConsentAuthRequest, ConsentTicketPayload } from "./consent-ticket";

// A3c — the pure consent flow logic (injected seams). buildConsent turns a parsed authorization request +
// the authenticated user into a signed consent ticket (or a safe OAuth error redirect); decideConsent
// verifies the round-tripped ticket against the live session and either completes the grant or denies.

const API = "https://api.webhook.co";
const MCP = "https://mcp.webhook.co";
/** Our RFC 9207 issuer identifier — stamped as `iss` on every authorization response (success + error). */
const ISSUER = "https://auth.webhook.co";
const CAPABILITY = ["events:read", "events:replay", "endpoints:read"];
const NOW = 1_000_000;
const TICKET_TTL = 600;
const GRANT_TTL = 7_776_000;
const KEY_TTL = 86_400;

function authRequest(over: Partial<ConsentAuthRequest> = {}): ConsentAuthRequest {
  return {
    responseType: "code",
    clientId: "cli_wbhk",
    redirectUri: "http://127.0.0.1:51763/callback",
    scope: ["events:read", "events:replay"],
    state: "st_123",
    codeChallenge: "chal",
    codeChallengeMethod: "S256",
    resource: API,
    ...over,
  };
}

function buildDeps(over: Partial<BuildConsentDeps> = {}): {
  deps: BuildConsentDeps;
  signed: { payload?: ConsentTicketPayload };
} {
  const signed: { payload?: ConsentTicketPayload } = {};
  const deps: BuildConsentDeps = {
    issuer: ISSUER,
    allowedAudiences: [API, MCP],
    allowedScopes: CAPABILITY,
    keyTtlSeconds: KEY_TTL,
    grantTtlSeconds: GRANT_TTL,
    ticketTtlSeconds: TICKET_TTL,
    consentPath: "/consent",
    lookupClientName: async () => "webhook CLI",
    getConsentOrg: async () => ({ orgId: "org_dana", name: "Dana's projects" }),
    signTicket: async (payload) => {
      signed.payload = payload;
      return "TICKET";
    },
    newCsrf: () => "csrf_fixed",
    nowSeconds: () => NOW,
    ...over,
  };
  return { deps, signed };
}

const ORIGIN = {
  ip: "203.0.113.7",
  location: "US",
  city: "San Francisco",
  region: "California",
  regionCode: "CA",
};

describe("buildConsent", () => {
  it("builds a consent redirect carrying a signed ticket with the resolved state", async () => {
    const { deps, signed } = buildDeps();
    const result = await buildConsent(deps, authRequest(), "user_dana", ORIGIN);
    expect(result).toEqual({ kind: "consent", location: "/consent?ticket=TICKET" });

    const p = signed.payload!;
    expect(p.userId).toBe("user_dana");
    expect(p.orgId).toBe("org_dana");
    expect(p.orgName).toBe("Dana's projects");
    expect(p.clientName).toBe("webhook CLI");
    // provenance sealed for the origin-honest screen: an opaque loopback CLI has no proven domain and isn't
    // vetted, but the code lands on its own machine.
    expect(p.clientIdentityDomain).toBeNull();
    expect(p.clientVerified).toBe(false);
    expect(p.redirectHost).toBe("127.0.0.1");
    expect(p.redirectIsLoopback).toBe(true);
    expect(p.audience).toBe(API);
    expect(p.scopes).toEqual(["events:read", "events:replay"]);
    expect(p.flow).toBe("pkce_loopback");
    expect(p.origin).toEqual(ORIGIN);
    expect(p.csrf).toBe("csrf_fixed");
    expect(p.keyTtlSeconds).toBe(KEY_TTL);
    expect(p.exp).toBe(NOW + TICKET_TTL);
    expect(p.grantExpiresAt).toBe(new Date((NOW + GRANT_TTL) * 1000).toISOString());
    expect(p.request).toEqual(authRequest());
    expect(p.device).toBeUndefined();
  });

  it("seals verified=true + the identity domain for an allowlisted vendor https redirect (DCR)", async () => {
    const { deps, signed } = buildDeps();
    // A DCR client (opaque id) with an allowlisted vendor https redirect — Claude Desktop's shape.
    const result = await buildConsent(
      deps,
      authRequest({ redirectUri: "https://claude.ai/api/mcp/auth_callback" }),
      "user_dana",
      ORIGIN,
    );
    expect(result.kind).toBe("consent");
    const p = signed.payload!;
    expect(p.clientVerified).toBe(true); // vetted via the redirect host
    expect(p.clientIdentityDomain).toBeNull(); // opaque id → no CIMD domain; the screen falls back to the host
    expect(p.redirectHost).toBe("claude.ai");
    expect(p.redirectIsLoopback).toBe(false);
  });

  it("seals the CIMD identity domain + verified=false for an arbitrary CIMD client", async () => {
    const { deps, signed } = buildDeps();
    // An arbitrary CIMD client: client_id is an https metadata URL, redirect same-origin. Not vetted.
    const result = await buildConsent(
      deps,
      authRequest({ clientId: "https://acme.dev/client.json", redirectUri: "https://acme.dev/cb" }),
      "user_dana",
      ORIGIN,
    );
    expect(result.kind).toBe("consent");
    const p = signed.payload!;
    expect(p.clientIdentityDomain).toBe("acme.dev");
    expect(p.clientVerified).toBe(false);
    expect(p.redirectHost).toBe("acme.dev");
    expect(p.redirectIsLoopback).toBe(false);
  });

  it("accepts the MCP-SDK trailing-slash audience and seals the CANONICAL (no-slash) value", async () => {
    // Claude Code / Claude Desktop send resource=https://mcp.webhook.co/ (new URL(origin).href). The sealed
    // audience must be the path-less MCP form so the minted token matches what the MCP server validates —
    // this is the invalid_target fix.
    const { deps, signed } = buildDeps();
    const result = await buildConsent(
      deps,
      authRequest({ resource: "https://mcp.webhook.co/" }),
      "user_dana",
      ORIGIN,
    );
    expect(result.kind).toBe("consent");
    expect(signed.payload!.audience).toBe("https://mcp.webhook.co"); // canonical, no trailing slash
  });

  it("still rejects a non-permitted audience even with a trailing slash (no widening)", async () => {
    const { deps } = buildDeps();
    const result = await buildConsent(
      deps,
      authRequest({ resource: "https://evil.example.com/" }),
      "user_dana",
      ORIGIN,
    );
    expect(result.kind).toBe("redirect");
    expect((result as { location: string }).location).toContain("error=invalid_target");
  });

  it("intersects requested scopes with capability (drops unknown scopes)", async () => {
    const { deps, signed } = buildDeps();
    const result = await buildConsent(
      deps,
      authRequest({ scope: ["events:read", "keys:manage", "totally:made-up"] }),
      "user_dana",
      ORIGIN,
    );
    expect(result.kind).toBe("consent");
    expect(signed.payload!.scopes).toEqual(["events:read"]);
  });

  it("rejects a non-loopback redirect_uri (cannot safely redirect) with a 400", async () => {
    const { deps } = buildDeps();
    const result = await buildConsent(
      deps,
      authRequest({ redirectUri: "https://evil.example.com/cb" }),
      "user_dana",
      ORIGIN,
    );
    expect(result).toEqual({
      kind: "bad_request",
      error: "invalid_request",
      description: expect.any(String),
    });
  });

  it("accepts an allowlisted vendor https redirect_uri (Claude Desktop / web MCP clients)", async () => {
    const { deps, signed } = buildDeps();
    const result = await buildConsent(
      deps,
      authRequest({ redirectUri: "https://claude.ai/api/mcp/auth_callback" }),
      "user_dana",
      ORIGIN,
    );
    expect(result.kind).toBe("consent");
    expect(signed.payload!.request.redirectUri).toBe("https://claude.ai/api/mcp/auth_callback");
  });

  it("omits state from the error redirect when the request carries an empty state", async () => {
    const { deps } = buildDeps();
    const result = await buildConsent(
      deps,
      authRequest({ resource: undefined, state: "" }),
      "user_dana",
      ORIGIN,
    );
    expect(result).toEqual({
      kind: "redirect",
      location:
        "http://127.0.0.1:51763/callback?error=invalid_target&iss=https%3A%2F%2Fauth.webhook.co",
    });
  });

  it("redirects invalid_target when the resource is missing or not an allowed audience", async () => {
    const { deps } = buildDeps();
    const missing = await buildConsent(
      deps,
      authRequest({ resource: undefined }),
      "user_dana",
      ORIGIN,
    );
    expect(missing).toEqual({
      kind: "redirect",
      location:
        "http://127.0.0.1:51763/callback?error=invalid_target&state=st_123&iss=https%3A%2F%2Fauth.webhook.co",
    });
    const wrong = await buildConsent(
      deps,
      authRequest({ resource: "https://other.example.com" }),
      "user_dana",
      ORIGIN,
    );
    expect(wrong.kind).toBe("redirect");
    expect((wrong as { location: string }).location).toContain("error=invalid_target");
  });

  it("redirects invalid_target when resource is an array of more than one", async () => {
    const { deps } = buildDeps();
    const result = await buildConsent(
      deps,
      authRequest({ resource: [API, MCP] }),
      "user_dana",
      ORIGIN,
    );
    expect(result.kind).toBe("redirect");
    expect((result as { location: string }).location).toContain("error=invalid_target");
  });

  it("accepts a single-element resource array", async () => {
    const { deps, signed } = buildDeps();
    const result = await buildConsent(deps, authRequest({ resource: [MCP] }), "user_dana", ORIGIN);
    expect(result.kind).toBe("consent");
    expect(signed.payload!.audience).toBe(MCP);
  });

  it("redirects invalid_scope when nothing requested is a capability scope", async () => {
    const { deps } = buildDeps();
    const result = await buildConsent(
      deps,
      authRequest({ scope: ["keys:manage", "nope:nope"] }),
      "user_dana",
      ORIGIN,
    );
    expect(result.kind).toBe("redirect");
    expect((result as { location: string }).location).toContain("error=invalid_scope");
  });

  it("redirects server_error when the user has no consent org", async () => {
    const { deps } = buildDeps({ getConsentOrg: async () => null });
    const result = await buildConsent(deps, authRequest(), "user_dana", ORIGIN);
    expect(result.kind).toBe("redirect");
    expect((result as { location: string }).location).toContain("error=server_error");
  });

  it("falls back to the client id for display when the client has no name", async () => {
    const { deps, signed } = buildDeps({ lookupClientName: async () => null });
    const result = await buildConsent(deps, authRequest(), "user_dana", ORIGIN);
    expect(result.kind).toBe("consent");
    expect(signed.payload!.clientName).toBe("cli_wbhk");
  });
});

function ticketPayload(over: Partial<ConsentTicketPayload> = {}): ConsentTicketPayload {
  return {
    request: authRequest(),
    userId: "user_dana",
    orgId: "org_dana",
    orgName: "Dana's projects",
    scopes: ["events:read", "events:replay"],
    audience: API,
    clientId: "cli_wbhk",
    clientName: "webhook CLI",
    clientIdentityDomain: null,
    clientVerified: false,
    redirectHost: "127.0.0.1",
    redirectIsLoopback: true,
    origin: ORIGIN,
    flow: "pkce_loopback",
    grantExpiresAt: "2026-09-18T00:00:00.000Z",
    keyTtlSeconds: KEY_TTL,
    csrf: "csrf_fixed",
    exp: NOW + TICKET_TTL,
    ...over,
  };
}

/** A device-code consent ticket (flow="device_code"; carries userCode, not an OAuth request). */
function deviceTicketPayload(over: Partial<ConsentTicketPayload> = {}): ConsentTicketPayload {
  return {
    flow: "device_code",
    userCode: "WXYZ-1234",
    userId: "user_dana",
    orgId: "org_dana",
    orgName: "Dana's projects",
    scopes: ["events:read", "events:replay"],
    audience: API,
    clientId: "cli_wbhk",
    clientName: "webhook CLI",
    clientIdentityDomain: null,
    clientVerified: false,
    redirectHost: null,
    redirectIsLoopback: false,
    origin: ORIGIN,
    grantExpiresAt: "2026-09-18T00:00:00.000Z",
    keyTtlSeconds: KEY_TTL,
    csrf: "csrf_fixed",
    exp: NOW + TICKET_TTL,
    ...over,
  };
}

function decideDeps(over: Partial<DecideConsentDeps> = {}): DecideConsentDeps {
  return {
    issuer: ISSUER,
    verifyTicket: async () => ticketPayload(),
    completeAuthorization: vi.fn(async () => ({
      redirectTo:
        "http://127.0.0.1:51763/callback?code=AC&state=st_123&iss=https%3A%2F%2Fauth.webhook.co",
    })),
    ...over,
  };
}

describe("decideConsent", () => {
  it("requires a live session (401 when unauthenticated)", async () => {
    const result = await decideConsent(decideDeps(), {
      requestId: "TICKET",
      csrfToken: "csrf_fixed",
      decision: "approve",
      sessionUserId: null,
    });
    expect(result).toEqual(expect.objectContaining({ kind: "error", status: 401 }));
  });

  it("rejects an invalid/expired ticket with a 400", async () => {
    const result = await decideConsent(decideDeps({ verifyTicket: async () => null }), {
      requestId: "bad",
      csrfToken: "csrf_fixed",
      decision: "approve",
      sessionUserId: "user_dana",
    });
    expect(result).toEqual(expect.objectContaining({ kind: "error", status: 400 }));
  });

  it("rejects when the live session is a different user than the ticket (403)", async () => {
    const result = await decideConsent(decideDeps(), {
      requestId: "TICKET",
      csrfToken: "csrf_fixed",
      decision: "approve",
      sessionUserId: "someone_else",
    });
    expect(result).toEqual(expect.objectContaining({ kind: "error", status: 403 }));
  });

  it("rejects a CSRF token that does not match the ticket (403)", async () => {
    const result = await decideConsent(decideDeps(), {
      requestId: "TICKET",
      csrfToken: "wrong",
      decision: "approve",
      sessionUserId: "user_dana",
    });
    expect(result).toEqual(expect.objectContaining({ kind: "error", status: 403 }));
  });

  it("approves: completes the authorization with consent props and the same userId (G1 invariant)", async () => {
    const complete = vi.fn(async () => ({
      redirectTo:
        "http://127.0.0.1:51763/callback?code=AC&state=st_123&iss=https%3A%2F%2Fauth.webhook.co",
    }));
    const result = await decideConsent(decideDeps({ completeAuthorization: complete }), {
      requestId: "TICKET",
      csrfToken: "csrf_fixed",
      decision: "approve",
      sessionUserId: "user_dana",
    });
    expect(result).toEqual({
      kind: "ok",
      redirectTo:
        "http://127.0.0.1:51763/callback?code=AC&state=st_123&iss=https%3A%2F%2Fauth.webhook.co",
    });
    expect(complete).toHaveBeenCalledWith({
      request: authRequest(),
      userId: "user_dana",
      scope: ["events:read", "events:replay"],
      metadata: {},
      props: {
        orgId: "org_dana",
        userId: "user_dana",
        scopes: ["events:read", "events:replay"],
        audience: API,
      },
    });
  });

  it("device approve: records the decision (props incl. device) and returns the device result, not completeAuthorization", async () => {
    const complete = vi.fn(async () => ({ redirectTo: "x" }));
    const setDeviceDecision = vi.fn(async () => "ok" as const);
    const result = await decideConsent(
      decideDeps({
        verifyTicket: async () => deviceTicketPayload({ device: { name: "Dana's laptop" } }),
        completeAuthorization: complete,
        setDeviceDecision,
      }),
      {
        requestId: "TICKET",
        csrfToken: "csrf_fixed",
        decision: "approve",
        sessionUserId: "user_dana",
      },
    );
    expect(result).toEqual({ kind: "ok", redirectTo: "/device?status=approved" });
    expect(complete).not.toHaveBeenCalled();
    expect(setDeviceDecision).toHaveBeenCalledWith("WXYZ-1234", {
      decision: "approve",
      props: {
        orgId: "org_dana",
        userId: "user_dana",
        scopes: ["events:read", "events:replay"],
        audience: API,
        device: { name: "Dana's laptop" },
      },
    });
  });

  it("device deny: records a deny and returns the denied result", async () => {
    const setDeviceDecision = vi.fn(async () => "ok" as const);
    const result = await decideConsent(
      decideDeps({ verifyTicket: async () => deviceTicketPayload(), setDeviceDecision }),
      {
        requestId: "TICKET",
        csrfToken: "csrf_fixed",
        decision: "deny",
        sessionUserId: "user_dana",
      },
    );
    expect(result).toEqual({ kind: "ok", redirectTo: "/device?status=denied" });
    expect(setDeviceDecision).toHaveBeenCalledWith("WXYZ-1234", { decision: "deny" });
  });

  it("device: a not_found/already_decided outcome maps to an error (no success redirect)", async () => {
    const notFound = await decideConsent(
      decideDeps({
        verifyTicket: async () => deviceTicketPayload(),
        setDeviceDecision: async () => "not_found" as const,
      }),
      {
        requestId: "TICKET",
        csrfToken: "csrf_fixed",
        decision: "approve",
        sessionUserId: "user_dana",
      },
    );
    expect(notFound).toEqual(expect.objectContaining({ kind: "error", status: 400 }));
    const decided = await decideConsent(
      decideDeps({
        verifyTicket: async () => deviceTicketPayload(),
        setDeviceDecision: async () => "already_decided" as const,
      }),
      {
        requestId: "TICKET",
        csrfToken: "csrf_fixed",
        decision: "approve",
        sessionUserId: "user_dana",
      },
    );
    expect(decided).toEqual(expect.objectContaining({ kind: "error", status: 409 }));
  });

  it("device: errors when the device decision seam isn't wired (unsupported)", async () => {
    const result = await decideConsent(
      decideDeps({ verifyTicket: async () => deviceTicketPayload(), setDeviceDecision: undefined }),
      {
        requestId: "TICKET",
        csrfToken: "csrf_fixed",
        decision: "approve",
        sessionUserId: "user_dana",
      },
    );
    expect(result).toEqual(
      expect.objectContaining({ kind: "error", status: 500, error: "server_error" }),
    );
  });

  it("device still enforces the session + csrf checks before deciding", async () => {
    const setDeviceDecision = vi.fn(async () => "ok" as const);
    const mismatch = await decideConsent(
      decideDeps({ verifyTicket: async () => deviceTicketPayload(), setDeviceDecision }),
      {
        requestId: "TICKET",
        csrfToken: "csrf_fixed",
        decision: "approve",
        sessionUserId: "someone_else",
      },
    );
    expect(mismatch).toEqual(expect.objectContaining({ kind: "error", status: 403 }));
    expect(setDeviceDecision).not.toHaveBeenCalled();
  });

  it("denies: redirects to the client redirect_uri with access_denied + state, never minting", async () => {
    const complete = vi.fn(async () => ({ redirectTo: "should-not-be-used" }));
    const result = await decideConsent(decideDeps({ completeAuthorization: complete }), {
      requestId: "TICKET",
      csrfToken: "csrf_fixed",
      decision: "deny",
      sessionUserId: "user_dana",
    });
    expect(result).toEqual({
      kind: "ok",
      redirectTo:
        "http://127.0.0.1:51763/callback?error=access_denied&state=st_123&iss=https%3A%2F%2Fauth.webhook.co",
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("denies without echoing state when the sealed request had an empty state", async () => {
    const result = await decideConsent(
      decideDeps({
        verifyTicket: async () => ticketPayload({ request: authRequest({ state: "" }) }),
      }),
      {
        requestId: "TICKET",
        csrfToken: "csrf_fixed",
        decision: "deny",
        sessionUserId: "user_dana",
      },
    );
    expect(result).toEqual({
      kind: "ok",
      redirectTo:
        "http://127.0.0.1:51763/callback?error=access_denied&iss=https%3A%2F%2Fauth.webhook.co",
    });
  });

  it("fails closed (400) and never completes if the sealed redirect_uri is not loopback", async () => {
    const complete = vi.fn(async () => ({ redirectTo: "x" }));
    const result = await decideConsent(
      decideDeps({
        completeAuthorization: complete,
        verifyTicket: async () =>
          ticketPayload({ request: authRequest({ redirectUri: "https://evil.example.com/cb" }) }),
      }),
      {
        requestId: "TICKET",
        csrfToken: "csrf_fixed",
        decision: "approve",
        sessionUserId: "user_dana",
      },
    );
    expect(result).toEqual(expect.objectContaining({ kind: "error", status: 400 }));
    expect(complete).not.toHaveBeenCalled();
  });

  it("completes an approval for an allowlisted vendor https redirect_uri (not just loopback)", async () => {
    const complete = vi.fn(async () => ({
      redirectTo:
        "https://claude.ai/api/mcp/auth_callback?code=AC&state=st_123&iss=https%3A%2F%2Fauth.webhook.co",
    }));
    const result = await decideConsent(
      decideDeps({
        completeAuthorization: complete,
        verifyTicket: async () =>
          ticketPayload({
            request: authRequest({ redirectUri: "https://claude.ai/api/mcp/auth_callback" }),
          }),
      }),
      {
        requestId: "TICKET",
        csrfToken: "csrf_fixed",
        decision: "approve",
        sessionUserId: "user_dana",
      },
    );
    expect(result).toEqual({
      kind: "ok",
      redirectTo:
        "https://claude.ai/api/mcp/auth_callback?code=AC&state=st_123&iss=https%3A%2F%2Fauth.webhook.co",
    });
    expect(complete).toHaveBeenCalledOnce();
  });
});

function deviceConsentDeps(over: Partial<BuildDeviceConsentDeps> = {}): {
  deps: BuildDeviceConsentDeps;
  signed: { payload?: ConsentTicketPayload };
} {
  const signed: { payload?: ConsentTicketPayload } = {};
  const deps: BuildDeviceConsentDeps = {
    allowedAudiences: [API, MCP],
    allowedScopes: CAPABILITY,
    keyTtlSeconds: KEY_TTL,
    grantTtlSeconds: GRANT_TTL,
    ticketTtlSeconds: TICKET_TTL,
    consentPath: "/consent",
    lookupClientName: async () => "webhook CLI",
    getConsentOrg: async () => ({ orgId: "org_dana", name: "Dana's projects" }),
    signTicket: async (payload) => {
      signed.payload = payload;
      return "TICKET";
    },
    newCsrf: () => "csrf_fixed",
    nowSeconds: () => NOW,
    ...over,
  };
  return { deps, signed };
}

const DEVICE_RECORD = {
  userCode: "WXYZ-1234",
  clientId: "cli_wbhk",
  scopes: ["events:read", "events:replay"],
  audience: API,
};

describe("buildDeviceConsent", () => {
  it("seals a device ticket (flow=device_code, userCode) and redirects to the shared consent screen", async () => {
    const { deps, signed } = deviceConsentDeps();
    const result = await buildDeviceConsent(deps, DEVICE_RECORD, "user_dana", ORIGIN);
    expect(result).toEqual({ kind: "consent", location: "/consent?ticket=TICKET" });

    const p = signed.payload!;
    expect(p.flow).toBe("device_code");
    if (p.flow !== "device_code") throw new Error("unreachable");
    expect(p.userCode).toBe("WXYZ-1234");
    expect(p.userId).toBe("user_dana");
    expect(p.orgId).toBe("org_dana");
    expect(p.clientId).toBe("cli_wbhk");
    expect(p.clientName).toBe("webhook CLI");
    // provenance: the device flow has NO redirect (the code is polled, not redirected), so redirectHost is
    // null + isLoopback false; an opaque client has no proven domain and isn't vetted.
    expect(p.clientIdentityDomain).toBeNull();
    expect(p.clientVerified).toBe(false);
    expect(p.redirectHost).toBeNull();
    expect(p.redirectIsLoopback).toBe(false);
    expect(p.scopes).toEqual(["events:read", "events:replay"]);
    expect(p.audience).toBe(API);
    expect(p.exp).toBe(NOW + TICKET_TTL);
  });

  it("seals verified=true + identity domain for a vetted CIMD client on the device flow", async () => {
    const { deps, signed } = deviceConsentDeps();
    await buildDeviceConsent(
      deps,
      { ...DEVICE_RECORD, clientId: "https://zed.dev/oauth/client-metadata.json" },
      "user_dana",
      ORIGIN,
    );
    const p = signed.payload!;
    expect(p.clientIdentityDomain).toBe("zed.dev");
    expect(p.clientVerified).toBe(true);
    expect(p.redirectHost).toBeNull(); // still no redirect on the device flow
  });

  it("intersects the record's scopes with capability (defense in depth)", async () => {
    const { deps, signed } = deviceConsentDeps();
    await buildDeviceConsent(
      deps,
      { ...DEVICE_RECORD, scopes: ["events:read", "totally:made-up"] },
      "user_dana",
      ORIGIN,
    );
    expect(signed.payload!.scopes).toEqual(["events:read"]);
  });

  it("errors invalid_target / invalid_scope / server_error on the respective failures", async () => {
    const badAud = await buildDeviceConsent(
      deviceConsentDeps().deps,
      { ...DEVICE_RECORD, audience: "https://evil" },
      "user_dana",
      ORIGIN,
    );
    expect(badAud).toEqual(expect.objectContaining({ kind: "error", error: "invalid_target" }));

    const noScope = await buildDeviceConsent(
      deviceConsentDeps().deps,
      { ...DEVICE_RECORD, scopes: ["nope:nope"] },
      "user_dana",
      ORIGIN,
    );
    expect(noScope).toEqual(expect.objectContaining({ kind: "error", error: "invalid_scope" }));

    const noOrg = await buildDeviceConsent(
      deviceConsentDeps({ getConsentOrg: async () => null }).deps,
      DEVICE_RECORD,
      "user_dana",
      ORIGIN,
    );
    expect(noOrg).toEqual(expect.objectContaining({ kind: "error", error: "server_error" }));
  });

  it("falls back to the client id for display when the client has no name", async () => {
    const { deps, signed } = deviceConsentDeps({ lookupClientName: async () => null });
    await buildDeviceConsent(deps, DEVICE_RECORD, "user_dana", ORIGIN);
    expect(signed.payload!.clientName).toBe("cli_wbhk");
  });
});
