import {
  CapabilityFault,
  UnauthenticatedError,
  type AuthContext,
  type BearerAuthzDeps,
  type VerifyBearer,
} from "@webhook-co/contract";
import type { CapabilityHandlers } from "@webhook-co/db";
import { b64ToBytes } from "@webhook-co/shared";
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
): CapabilityHandlers {
  return new Map(Object.entries(impl));
}
function get(path: string, token: string | null = "whk_ok"): Request {
  return new Request(`${RESOURCE}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}
function post(path: string, body: unknown, token: string | null = "whk_ok"): Request {
  return new Request(`${RESOURCE}${path}`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
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

  it("builds events.tail input from the ?since grammar (server-resolved)", async () => {
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
    await handleRequest(get(`/v1/endpoints/${EP}/events/tail?since=2h`), deps);
    expect(seen).toEqual({ endpointId: EP, since: "2h" });
  });

  it("emits the events.tail cursor-contract fields verbatim (headCursor + caughtUp + lag)", async () => {
    const output = {
      items: [],
      nextCursor: null,
      headCursor: "sig.head",
      caughtUp: true,
      lag: { backlogCount: 7, headLagMs: 1200 },
    };
    const deps: ApiDeps = {
      authDeps: authDeps(verify(scoped)),
      handlers: handlersOf({ "events.tail": async () => output }),
    };
    const res = await handleRequest(get(`/v1/endpoints/${EP}/events/tail`), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(output); // pass-through — Response.json(handler output)
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

describe("handleRequest — GET /v1/events/:id/payload (events.getPayload)", () => {
  const EVENT_ID = "55555555-5555-7555-8555-555555555555";

  // A fake R2 bucket: `body` bytes wrapped as an R2 object, or null for a missing object.
  function r2(body: Uint8Array | null): R2Bucket {
    return {
      get: async () =>
        body === null
          ? null
          : ({ arrayBuffer: async () => body.buffer } as unknown as R2ObjectBody),
    } as unknown as R2Bucket;
  }
  // events.get resolves the metadata (RLS-checked upstream); the payload route reuses it for the key.
  const eventsGetOk = (
    payloadR2Key = "org/x/ep/y/z",
    contentType: string | null = "application/json",
  ): CapabilityHandlers =>
    handlersOf({ "events.get": async () => ({ id: EVENT_ID, payloadR2Key, contentType }) });

  it("returns a base64 envelope whose bytes round-trip exactly", async () => {
    const body = new TextEncoder().encode('{"hello":"world"}');
    const deps: ApiDeps = {
      authDeps: authDeps(verify(scoped)),
      handlers: eventsGetOk(),
      payloads: r2(body),
    };
    const res = await handleRequest(get(`/v1/events/${EVENT_ID}/payload`), deps);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      contentType: string | null;
      bytes: number;
      bodyBase64: string;
    };
    expect(json.contentType).toBe("application/json");
    expect(json.bytes).toBe(body.byteLength);
    expect([...b64ToBytes(json.bodyBase64)]).toEqual([...body]);
  });

  it("404s when the event isn't found (the events.get RLS fault maps through)", async () => {
    const deps: ApiDeps = {
      authDeps: authDeps(verify(scoped)),
      handlers: handlersOf({
        "events.get": async () => {
          throw new CapabilityFault("NOT_FOUND", "event not found");
        },
      }),
      payloads: r2(new Uint8Array()),
    };
    const res = await handleRequest(get(`/v1/events/${EVENT_ID}/payload`), deps);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "NOT_FOUND" });
  });

  it("404s when the row exists but the R2 body object is missing", async () => {
    const deps: ApiDeps = {
      authDeps: authDeps(verify(scoped)),
      handlers: eventsGetOk(),
      payloads: r2(null),
    };
    const res = await handleRequest(get(`/v1/events/${EVENT_ID}/payload`), deps);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "NOT_FOUND" });
  });

  it("401s without a credential", async () => {
    const deps: ApiDeps = {
      authDeps: authDeps(verify(scoped)),
      handlers: eventsGetOk(),
      payloads: r2(new Uint8Array()),
    };
    const res = await handleRequest(get(`/v1/events/${EVENT_ID}/payload`, null), deps);
    expect(res.status).toBe(401);
  });

  it("propagates a 5xx when the R2 binding is absent (a wiring bug, not a client error)", async () => {
    const deps: ApiDeps = { authDeps: authDeps(verify(scoped)), handlers: eventsGetOk() };
    await expect(handleRequest(get(`/v1/events/${EVENT_ID}/payload`), deps)).rejects.toThrow(
      /R2_PAYLOADS/,
    );
  });
});

describe("handleRequest — POST /v1/events/:id/replay (events.replay)", () => {
  const EVENT_ID = "55555555-5555-7555-8555-555555555555";
  const replayScoped: AuthContext = { orgId: ORG, scopes: ["events:replay"] };
  const TARGET = { kind: "localhost-tunnel", sessionId: "s1" };
  const attempt = {
    id: "a1",
    orgId: ORG,
    eventId: EVENT_ID,
    target: JSON.stringify(TARGET),
    idempotencyKey: "k1",
    status: "forwarded",
    statusCode: null,
    attempt: 1,
    error: null,
    createdAt: "2026-06-18T00:00:00.000Z",
  };

  it("merges the path eventId with the JSON body and calls the replay handler", async () => {
    let seen: unknown;
    const deps: ApiDeps = {
      authDeps: authDeps(verify(replayScoped)),
      handlers: handlersOf({}),
      replay: async (_ctx, input) => {
        seen = input;
        return attempt;
      },
    };
    const res = await handleRequest(
      post(`/v1/events/${EVENT_ID}/replay`, { target: TARGET, idempotencyKey: "k1" }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual({ target: TARGET, idempotencyKey: "k1", eventId: EVENT_ID });
    expect(await res.json()).toMatchObject({ status: "forwarded" });
  });

  it("the path eventId is authoritative over a spoofed body eventId", async () => {
    let seen: unknown;
    const deps: ApiDeps = {
      authDeps: authDeps(verify(replayScoped)),
      handlers: handlersOf({}),
      replay: async (_ctx, input) => {
        seen = input;
        return attempt;
      },
    };
    await handleRequest(
      post(`/v1/events/${EVENT_ID}/replay`, {
        eventId: "spoofed",
        target: TARGET,
        idempotencyKey: "k",
      }),
      deps,
    );
    expect((seen as { eventId: string }).eventId).toBe(EVENT_ID);
  });

  it("maps a handler ENDPOINT_PAUSED fault to 409", async () => {
    const deps: ApiDeps = {
      authDeps: authDeps(verify(replayScoped)),
      handlers: handlersOf({}),
      replay: async () => {
        throw new CapabilityFault("ENDPOINT_PAUSED", "endpoint is paused");
      },
    };
    const res = await handleRequest(
      post(`/v1/events/${EVENT_ID}/replay`, { target: TARGET, idempotencyKey: "k" }),
      deps,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "ENDPOINT_PAUSED" });
  });

  it("400s a malformed JSON body as VALIDATION_ERROR", async () => {
    const deps: ApiDeps = {
      authDeps: authDeps(verify(replayScoped)),
      handlers: handlersOf({}),
      replay: async () => attempt,
    };
    const req = new Request(`${RESOURCE}/v1/events/${EVENT_ID}/replay`, {
      method: "POST",
      headers: { authorization: "Bearer whk_ok", "content-type": "application/json" },
      body: "{not json",
    });
    const res = await handleRequest(req, deps);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "VALIDATION_ERROR" });
  });

  it("403s without the events:replay scope", async () => {
    const deps: ApiDeps = {
      authDeps: authDeps(verify(scoped)),
      handlers: handlersOf({}),
      replay: async () => attempt,
    };
    const res = await handleRequest(
      post(`/v1/events/${EVENT_ID}/replay`, { target: TARGET, idempotencyKey: "k" }),
      deps,
    );
    expect(res.status).toBe(403);
  });

  it("propagates a 5xx when the replay handler is not bound (wiring bug)", async () => {
    const deps: ApiDeps = { authDeps: authDeps(verify(replayScoped)), handlers: handlersOf({}) };
    await expect(
      handleRequest(
        post(`/v1/events/${EVENT_ID}/replay`, { target: TARGET, idempotencyKey: "k" }),
        deps,
      ),
    ).rejects.toThrow(/replay handler/);
  });
});

describe("handleRequest — POST /v1/endpoints (endpoints.create)", () => {
  const writeScoped: AuthContext = { orgId: ORG, scopes: ["endpoints:write"] };
  const created = {
    id: EP,
    orgId: ORG,
    name: "stripe prod",
    paused: false,
    createdAt: "2026-06-25T00:00:00.000Z",
    ingestUrl: "https://wbhk.my/whep_one_time_secret",
  };

  it("dispatches the JSON body to the shared endpoints.create handler and returns the created endpoint", async () => {
    let seen: unknown;
    const deps: ApiDeps = {
      authDeps: authDeps(verify(writeScoped)),
      handlers: handlersOf({
        "endpoints.create": async (_ctx, input) => {
          seen = input;
          return created;
        },
      }),
    };
    const res = await handleRequest(post("/v1/endpoints", { name: "stripe prod" }), deps);
    expect(res.status).toBe(200);
    expect(seen).toEqual({ name: "stripe prod" }); // the whole body is the input
    expect(await res.json()).toEqual(created); // pass-through — Response.json(handler output)
  });

  it("403s (insufficient_scope) without endpoints:write and never reaches the handler", async () => {
    let called = false;
    const deps: ApiDeps = {
      authDeps: authDeps(verify(scoped)), // read scopes only
      handlers: handlersOf({
        "endpoints.create": async () => {
          called = true;
          return created;
        },
      }),
    };
    const res = await handleRequest(post("/v1/endpoints", { name: "x" }), deps);
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(called).toBe(false); // edge gate stops it before any mint
  });

  it("401s without a credential", async () => {
    const deps: ApiDeps = {
      authDeps: authDeps(verify(writeScoped)),
      handlers: handlersOf({ "endpoints.create": async () => created }),
    };
    const res = await handleRequest(post("/v1/endpoints", { name: "x" }, null), deps);
    expect(res.status).toBe(401);
  });

  it("400s a malformed JSON body as VALIDATION_ERROR", async () => {
    const deps: ApiDeps = {
      authDeps: authDeps(verify(writeScoped)),
      handlers: handlersOf({ "endpoints.create": async () => created }),
    };
    const req = new Request(`${RESOURCE}/v1/endpoints`, {
      method: "POST",
      headers: { authorization: "Bearer whk_ok", "content-type": "application/json" },
      body: "{not json",
    });
    const res = await handleRequest(req, deps);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "VALIDATION_ERROR" });
  });

  it("maps a handler RATE_LIMITED fault (the per-org soft cap) to 429", async () => {
    const deps: ApiDeps = {
      authDeps: authDeps(verify(writeScoped)),
      handlers: handlersOf({
        "endpoints.create": async () => {
          throw new CapabilityFault("RATE_LIMITED", "endpoint limit reached");
        },
      }),
    };
    const res = await handleRequest(post("/v1/endpoints", { name: "x" }), deps);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "RATE_LIMITED" });
  });

  it("propagates a 5xx when the endpoints.create handler is not bound (wiring bug)", async () => {
    const deps: ApiDeps = { authDeps: authDeps(verify(writeScoped)), handlers: handlersOf({}) };
    await expect(handleRequest(post("/v1/endpoints", { name: "x" }), deps)).rejects.toThrow(
      /endpoints\.create/,
    );
  });
});
