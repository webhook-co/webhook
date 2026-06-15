import {
  CapabilityFault,
  UnauthenticatedError,
  type AuthContext,
  type BearerAuthzDeps,
  type VerifyBearer,
} from "@webhook-co/contract";
import type { ReadHandlers } from "@webhook-co/db";
import { describe, expect, it } from "vitest";

import { handleRequest, type ApiDeps } from "./router.js";

const RESOURCE = "https://api.webhook.co";
const PRM_URL = `${RESOURCE}/.well-known/oauth-protected-resource`;
const ORG = "33333333-3333-7333-8333-333333333333";
const EP = "44444444-4444-7444-8444-444444444444";

function verify(result: AuthContext | { throws: unknown }): VerifyBearer {
  return async () => {
    if ("throws" in result) throw result.throws;
    return result;
  };
}
function authDeps(v: VerifyBearer): BearerAuthzDeps {
  return { verifyBearer: v, resource: RESOURCE, resourceMetadataUrl: PRM_URL };
}
function handlersOf(
  impl: Record<string, (ctx: AuthContext, input: unknown) => Promise<unknown>>,
): ReadHandlers {
  return new Map(Object.entries(impl));
}
function get(path: string, token: string | null = "whk_ok"): Request {
  return new Request(`${RESOURCE}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}
const scoped: AuthContext = { orgId: ORG, scopes: ["endpoints:read", "events:read", "audit:read"] };

describe("handleRequest — routing, auth, input construction, error mapping", () => {
  it("dispatches GET /v1/endpoints to endpoints.list, building input from the query", async () => {
    let seen: unknown;
    const deps: ApiDeps = {
      authDeps: authDeps(verify(scoped)),
      handlers: handlersOf({
        "endpoints.list": async (_ctx, input) => {
          seen = input;
          return { items: [], nextCursor: null };
        },
      }),
    };
    const res = await handleRequest(get("/v1/endpoints?limit=10&cursor=abc.def"), deps);
    expect(res.status).toBe(200);
    expect(seen).toEqual({ limit: 10, cursor: "abc.def" });
    expect(await res.json()).toEqual({ items: [], nextCursor: null });
  });

  it("builds events.list input from the path + provider filter", async () => {
    let seen: unknown;
    const deps: ApiDeps = {
      authDeps: authDeps(verify(scoped)),
      handlers: handlersOf({
        "events.list": async (_ctx, input) => {
          seen = input;
          return { items: [], nextCursor: null };
        },
      }),
    };
    await handleRequest(get(`/v1/endpoints/${EP}/events?provider=stripe`), deps);
    expect(seen).toEqual({ endpointId: EP, filter: { provider: "stripe" } });
  });

  it("builds events.tail input from the path + optional sinceCursor", async () => {
    let seen: unknown;
    const deps: ApiDeps = {
      authDeps: authDeps(verify(scoped)),
      handlers: handlersOf({
        "events.tail": async (_ctx, input) => {
          seen = input;
          return { items: [], nextCursor: null };
        },
      }),
    };
    await handleRequest(get(`/v1/endpoints/${EP}/events/tail?sinceCursor=abc.def`), deps);
    expect(seen).toEqual({ endpointId: EP, sinceCursor: "abc.def" });
  });

  it("builds events.tail input with no cursor when sinceCursor is absent", async () => {
    let seen: unknown;
    const deps: ApiDeps = {
      authDeps: authDeps(verify(scoped)),
      handlers: handlersOf({
        "events.tail": async (_ctx, input) => {
          seen = input;
          return { items: [], nextCursor: null };
        },
      }),
    };
    await handleRequest(get(`/v1/endpoints/${EP}/events/tail`), deps);
    expect(seen).toEqual({ endpointId: EP });
  });

  it("dispatches POST /v1/audit/verify", async () => {
    const deps: ApiDeps = {
      authDeps: authDeps(verify(scoped)),
      handlers: handlersOf({ "audit.verify": async () => ({ ok: true, rowsVerified: 0 }) }),
    };
    const req = new Request(`${RESOURCE}/v1/audit/verify`, {
      method: "POST",
      headers: { authorization: "Bearer whk_ok" },
    });
    const res = await handleRequest(req, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, rowsVerified: 0 });
  });

  it("401s with an invalid_token challenge when no credential is present", async () => {
    const deps: ApiDeps = {
      authDeps: authDeps(verify(scoped)),
      handlers: handlersOf({ "endpoints.list": async () => ({}) }),
    };
    const res = await handleRequest(get("/v1/endpoints", null), deps);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("403s with insufficient_scope when authenticated but under-scoped", async () => {
    const deps: ApiDeps = {
      authDeps: authDeps(verify({ orgId: ORG, scopes: [] })),
      handlers: handlersOf({ "endpoints.list": async () => ({}) }),
    };
    const res = await handleRequest(get("/v1/endpoints"), deps);
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
  });

  it("maps a handler CapabilityFault to its HTTP status + a JSON error body", async () => {
    const deps: ApiDeps = {
      authDeps: authDeps(verify(scoped)),
      handlers: handlersOf({
        "endpoints.get": async () => {
          throw new CapabilityFault("NOT_FOUND", "endpoint not found");
        },
      }),
    };
    const res = await handleRequest(get(`/v1/endpoints/${EP}`), deps);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "NOT_FOUND" });
  });

  it("propagates an operational error (the surface returns 5xx, never masks it)", async () => {
    const deps: ApiDeps = {
      authDeps: authDeps(verify({ throws: new Error("hyperdrive: connection reset") })),
      handlers: handlersOf({ "endpoints.list": async () => ({}) }),
    };
    await expect(handleRequest(get("/v1/endpoints"), deps)).rejects.toThrow(/connection reset/);
  });

  it("404s an unknown path", async () => {
    const deps: ApiDeps = { authDeps: authDeps(verify(scoped)), handlers: handlersOf({}) };
    expect((await handleRequest(get("/v1/nonsense"), deps)).status).toBe(404);
  });
});

describe("handleRequest — GET /v1/whoami (scope-free identity)", () => {
  it("returns the authenticated principal with NO scope required (even a scopeless key)", async () => {
    const deps: ApiDeps = {
      authDeps: authDeps(verify({ orgId: ORG, scopes: [] })),
      handlers: handlersOf({}),
    };
    const res = await handleRequest(get("/v1/whoami"), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgId: ORG, scopes: [] });
  });

  it("includes the scopes and a userId when present", async () => {
    const deps: ApiDeps = {
      authDeps: authDeps(verify({ orgId: ORG, userId: "usr_1", scopes: ["events:read"] })),
      handlers: handlersOf({}),
    };
    const res = await handleRequest(get("/v1/whoami"), deps);
    expect(await res.json()).toEqual({ orgId: ORG, userId: "usr_1", scopes: ["events:read"] });
  });

  it("401s with invalid_token when no credential is present", async () => {
    const deps: ApiDeps = { authDeps: authDeps(verify(scoped)), handlers: handlersOf({}) };
    const res = await handleRequest(get("/v1/whoami", null), deps);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("401s when the credential doesn't resolve (unauthenticated)", async () => {
    const deps: ApiDeps = {
      authDeps: authDeps(verify({ throws: new UnauthenticatedError() })),
      handlers: handlersOf({}),
    };
    expect((await handleRequest(get("/v1/whoami"), deps)).status).toBe(401);
  });

  it("propagates an operational fault as a 5xx (never a masked 401)", async () => {
    const deps: ApiDeps = {
      authDeps: authDeps(verify({ throws: new Error("hyperdrive down") })),
      handlers: handlersOf({}),
    };
    await expect(handleRequest(get("/v1/whoami"), deps)).rejects.toThrow(/hyperdrive down/);
  });
});
