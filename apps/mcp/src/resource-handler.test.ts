import {
  buildProtectedResourceMetadata,
  UnauthenticatedError,
  type AuthContext,
  type VerifyBearer,
} from "@webhook-co/contract";
import { describe, expect, it, vi } from "vitest";

import {
  handleResourceRequest,
  type McpExecutionContext,
  type ResourceHandlerDeps,
} from "./resource-handler";

// A8b — the mcp resource-server router (pure, injected). Replaces the co-located OAuthProvider: it
// serves RFC 9728 PRM (pointing at the auth. issuer), challenges unauthenticated /mcp requests, and —
// on a valid bearer — sets the principal on the execution context and hands off to the McpAgent DO.

const RESOURCE = "https://mcp.webhook.co";
const PRM_PATH = "/.well-known/oauth-protected-resource";
const PRM_URL = `${RESOURCE}${PRM_PATH}`;
const AUTH_ISSUER = "https://auth.webhook.co";
const CTX: AuthContext = { orgId: "org_1", scopes: ["events:read"] };

const SERVED = new Response("served-by-mcp-agent", { status: 200 });

function fakeCtx(): McpExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {}, props: undefined };
}

function deps(over: Partial<ResourceHandlerDeps> = {}): ResourceHandlerDeps {
  return {
    authDeps: {
      verifyBearer: async () => CTX,
      resource: RESOURCE,
      resourceMetadataUrl: PRM_URL,
    },
    resourceMetadata: buildProtectedResourceMetadata({
      resource: RESOURCE,
      authorizationServers: [AUTH_ISSUER],
      scopesSupported: ["events:read"],
    }),
    prmPath: PRM_PATH,
    serveMcp: vi.fn(async () => SERVED.clone()),
    setProps: vi.fn(),
    // Fakes for the A8c session-binding seams (the real crypto is unit-tested in session-binding.test.ts):
    // bind wraps `id` → `bound:id`; unbind unwraps that, returning null for anything else (a cross-principal
    // or invalid id).
    bindSession: vi.fn(async (id: string) => `bound:${id}`),
    unbindSession: vi.fn(async (id: string) =>
      id.startsWith("bound:") ? id.slice("bound:".length) : null,
    ),
    ...over,
  };
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`${RESOURCE}${path}`, init);
}

describe("handleResourceRequest", () => {
  it("serves RFC 9728 PRM (authorization_servers → the auth. issuer, not mcp) on the well-known path", async () => {
    const serveMcp = vi.fn(async () => SERVED.clone());
    const res = await handleResourceRequest(deps({ serveMcp }), req(PRM_PATH), {}, fakeCtx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported?: string[];
    };
    expect(body.resource).toBe(RESOURCE);
    expect(body.authorization_servers).toEqual([AUTH_ISSUER]);
    expect(body.authorization_servers).not.toContain(RESOURCE); // mcp is no longer an issuer
    expect(serveMcp).not.toHaveBeenCalled();
  });

  it("serves a health check without touching auth", async () => {
    const res = await handleResourceRequest(deps(), req("/healthz"), {}, fakeCtx());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ok");
  });

  it("challenges an unauthenticated /mcp request with 401 + a PRM-pointing WWW-Authenticate", async () => {
    const serveMcp = vi.fn(async () => SERVED.clone());
    const setProps = vi.fn();
    const res = await handleResourceRequest(
      deps({ serveMcp, setProps }),
      req("/mcp", { method: "POST" }),
      {},
      fakeCtx(),
    );
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer/i);
    expect(challenge).toContain("resource_metadata=");
    expect(challenge).toContain(PRM_PATH);
    expect(serveMcp).not.toHaveBeenCalled();
    expect(setProps).not.toHaveBeenCalled();
  });

  it("sets the resolved principal on ctx and hands a valid /mcp request to the McpAgent", async () => {
    const serveMcp = vi.fn(async () => SERVED.clone());
    const setProps = vi.fn();
    const ctx = fakeCtx();
    const env = { marker: true };
    const request = req("/mcp", { method: "POST", headers: { authorization: "Bearer whk_good" } });
    const res = await handleResourceRequest(deps({ serveMcp, setProps }), request, env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("served-by-mcp-agent");
    expect(setProps).toHaveBeenCalledWith(ctx, CTX);
    expect(serveMcp).toHaveBeenCalledWith(request, env, ctx);
    // props MUST be set before the hand-off (the DO reads them at session init).
    expect(setProps.mock.invocationCallOrder[0]).toBeLessThan(serveMcp.mock.invocationCallOrder[0]);
  });

  it("rejects (401) a request carrying more than one Authorization credential, without resolving it", async () => {
    // Duplicate `Authorization` headers coalesce (Fetch API) into one comma-joined value. We must not
    // parse the first and ignore the rest — reject the ambiguous request outright.
    const verifyBearer = vi.fn<VerifyBearer>(async () => CTX);
    const serveMcp = vi.fn(async () => SERVED.clone());
    const setProps = vi.fn();
    const headers = new Headers();
    headers.append("authorization", "Bearer whk_a");
    headers.append("authorization", "Bearer whk_b");
    const res = await handleResourceRequest(
      deps({
        authDeps: { verifyBearer, resource: RESOURCE, resourceMetadataUrl: PRM_URL },
        serveMcp,
        setProps,
      }),
      req("/mcp", { method: "POST", headers }),
      {},
      fakeCtx(),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate") ?? "").toMatch(/^Bearer/i);
    expect(verifyBearer).not.toHaveBeenCalled();
    expect(serveMcp).not.toHaveBeenCalled();
    expect(setProps).not.toHaveBeenCalled();
  });

  it("challenges (401) when the bearer doesn't resolve, without handing off", async () => {
    const verifyBearer: VerifyBearer = async () => {
      throw new UnauthenticatedError();
    };
    const serveMcp = vi.fn(async () => SERVED.clone());
    const res = await handleResourceRequest(
      deps({
        authDeps: { verifyBearer, resource: RESOURCE, resourceMetadataUrl: PRM_URL },
        serveMcp,
      }),
      req("/mcp", { method: "POST", headers: { authorization: "Bearer whk_bad" } }),
      {},
      fakeCtx(),
    );
    expect(res.status).toBe(401);
    expect(serveMcp).not.toHaveBeenCalled();
  });

  it("propagates an operational fault (→ 5xx at the wrapper) rather than masking it as a 401", async () => {
    const verifyBearer: VerifyBearer = async () => {
      throw new Error("hyperdrive down");
    };
    await expect(
      handleResourceRequest(
        deps({ authDeps: { verifyBearer, resource: RESOURCE, resourceMetadataUrl: PRM_URL } }),
        req("/mcp", { method: "POST", headers: { authorization: "Bearer whk_x" } }),
        {},
        fakeCtx(),
      ),
    ).rejects.toThrow("hyperdrive down");
  });

  it("passes a CORS preflight (OPTIONS) to the McpAgent without requiring auth", async () => {
    const serveMcp = vi.fn(async () => new Response(null, { status: 204 }));
    const setProps = vi.fn();
    const res = await handleResourceRequest(
      deps({ serveMcp, setProps }),
      req("/mcp", { method: "OPTIONS" }),
      {},
      fakeCtx(),
    );
    expect(res.status).toBe(204);
    expect(serveMcp).toHaveBeenCalledOnce();
    expect(setProps).not.toHaveBeenCalled();
  });

  it("404s an unknown path", async () => {
    const res = await handleResourceRequest(deps(), req("/nope"), {}, fakeCtx());
    expect(res.status).toBe(404);
  });

  // A8c — per-request principal isolation.
  it("wraps the transport-assigned session id (initialize) into a principal-bound id on the way out", async () => {
    const bindSession = vi.fn(async (id: string) => `bound:${id}`);
    const serveMcp = vi.fn(
      async () => new Response("ok", { status: 200, headers: { "mcp-session-id": "G" } }),
    );
    const res = await handleResourceRequest(
      deps({ bindSession, serveMcp }),
      // no inbound session id = the initialize request
      req("/mcp", { method: "POST", headers: { authorization: "Bearer whk_a" } }),
      {},
      fakeCtx(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBe("bound:G");
    expect(bindSession).toHaveBeenCalledWith("G", CTX);
  });

  it("unwraps a presented (bound) session id to the base id before the transport routes the DO", async () => {
    let seen: string | null = null;
    const serveMcp = vi.fn(async (r: Request) => {
      seen = r.headers.get("mcp-session-id");
      return SERVED.clone();
    });
    await handleResourceRequest(
      deps({ serveMcp }),
      req("/mcp", {
        method: "POST",
        headers: { authorization: "Bearer whk_a", "mcp-session-id": "bound:G" },
      }),
      {},
      fakeCtx(),
    );
    expect(seen).toBe("G"); // the transport sees the base id, not the wrapped one
  });

  it("REJECTS a session id that doesn't unbind to this principal (404), without reaching the transport", async () => {
    const serveMcp = vi.fn(async () => SERVED.clone());
    const setProps = vi.fn();
    const res = await handleResourceRequest(
      deps({ serveMcp, setProps }),
      req("/mcp", {
        method: "POST",
        // a stolen/forged id another principal presents → unbindSession returns null
        headers: { authorization: "Bearer whk_b", "mcp-session-id": "someone-elses-session" },
      }),
      {},
      fakeCtx(),
    );
    expect(res.status).toBe(404);
    expect(serveMcp).not.toHaveBeenCalled();
    expect(setProps).not.toHaveBeenCalled();
  });
});
