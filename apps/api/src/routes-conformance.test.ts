import {
  CAPABILITY_REGISTRY,
  CAPABILITY_SCOPES,
  type AuthContext,
  type BearerAuthzDeps,
  type VerifyBearer,
} from "@webhook-co/contract";
import type { CapabilityHandlers } from "@webhook-co/db";
import { ROUTES, type RouteDef } from "@webhook-co/openapi/routes";
import { describe, expect, it } from "vitest";

import { handleRequest, type ApiDeps } from "./router.js";

// Layer-3 drift guard: drive the REAL handleRequest for EVERY route in the manifest and assert the
// observed HTTP behavior matches what the OpenAPI generator declares from the same manifest — 200 + JSON on
// success, EMPTY-body 401/403 with a WWW-Authenticate header on the auth gate, text/plain on a routing miss.
// The schema-level drift guard lives in @webhook-co/openapi; this proves the hand-written HTTP envelope
// (the one thing the contract can't express) actually behaves as the spec claims, for all 27 operations.

const RESOURCE = "https://api.webhook.co";
const PRM_URL = `${RESOURCE}/.well-known/oauth-protected-resource`;
const ORG = "33333333-3333-7333-8333-333333333333";
const UUID = "11111111-1111-7111-8111-111111111111";

function verify(result: AuthContext | { throws: unknown }): VerifyBearer {
  return async () => {
    if ("throws" in result) throw result.throws;
    return result;
  };
}
function authDeps(v: VerifyBearer): BearerAuthzDeps {
  return { verifyBearer: v, resource: RESOURCE, resourceMetadataUrl: PRM_URL };
}

/** A concrete request path from a route template (every {param} → a valid uuid). */
function concretePath(route: RouteDef): string {
  return route.path.replace(/\{\w+\}/g, UUID);
}
function request(route: RouteDef, token: string | null): Request {
  const init: RequestInit = {
    method: route.method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
  if (route.body) {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = "{}";
  }
  return new Request(`${RESOURCE}${concretePath(route)}`, init);
}

/** Deps whose every handler map records the dispatched capability and returns a canned 200 output. */
function makeDeps(record: (cap: string) => void, principal: AuthContext): ApiDeps {
  const handler = (cap: string) => async (): Promise<unknown> => {
    record(cap);
    // events.get feeds the payload route's RLS read; give it the projected shape.
    if (cap === "events.get") return { payloadR2Key: "k", contentType: "application/json" };
    return { ok: true };
  };
  const mapFor = (dispatch: string): CapabilityHandlers =>
    new Map(
      ROUTES.filter((r) => r.dispatch === dispatch && r.capability !== null).map((r) => [
        r.capability as string,
        handler(r.capability as string),
      ]),
    );
  // The payload route reuses events.get from the shared map; ensure it's present there.
  const shared = mapFor("shared");
  shared.set("events.get", handler("events.get"));
  return {
    authDeps: authDeps(verify(principal)),
    handlers: shared,
    replay: async () => {
      record("events.replay");
      return { ok: true };
    },
    replayDestinations: mapFor("replayDestinations"),
    subscriptions: mapFor("subscriptions"),
    payloads: {
      get: async () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }),
    } as unknown as R2Bucket,
  };
}

const fullPrincipal: AuthContext = { orgId: ORG, scopes: [...CAPABILITY_SCOPES] };

describe("Layer-3 conformance — every manifest route behaves as the spec declares", () => {
  it.each(ROUTES.map((r) => [`${r.method} ${r.path}`, r] as const))(
    "%s → 200 JSON, dispatching the right capability",
    async (_label, route) => {
      let dispatched: string | null = null;
      const deps = makeDeps((cap) => {
        dispatched = cap;
      }, fullPrincipal);
      const res = await handleRequest(request(route, "whk_ok"), deps);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      if (route.capability !== null && route.dispatch !== "payload") {
        expect(dispatched).toBe(route.capability);
      }
    },
  );

  it.each(ROUTES.map((r) => [`${r.method} ${r.path}`, r] as const))(
    "%s → 401 EMPTY body + WWW-Authenticate when unauthenticated",
    async (_label, route) => {
      const deps = makeDeps(() => {}, fullPrincipal);
      const res = await handleRequest(request(route, null), deps);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer /);
      expect(await res.text()).toBe(""); // empty-body auth error, exactly as the spec's Unauthorized response
    },
  );

  it("under-scoped capability routes return 403 EMPTY body + WWW-Authenticate (insufficient_scope)", async () => {
    const scopeless: AuthContext = { orgId: ORG, scopes: [] };
    for (const route of ROUTES) {
      if (route.capability === null) continue; // whoami is scope-free
      const deps = makeDeps(() => {}, scopeless);
      const res = await handleRequest(request(route, "whk_ok"), deps);
      expect(res.status, `${route.method} ${route.path}`).toBe(403);
      expect(res.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
      expect(await res.text()).toBe("");
    }
  });

  it("a routing miss is a text/plain 404 (distinct from a JSON NOT_FOUND fault)", async () => {
    const deps = makeDeps(() => {}, fullPrincipal);
    const res = await handleRequest(new Request(`${RESOURCE}/v1/nonsense`), deps);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("every route's capability declares the scope the router enforced (registry cross-check)", () => {
    for (const route of ROUTES) {
      if (route.capability === null) continue;
      const cap = CAPABILITY_REGISTRY.get(route.capability);
      expect(cap, route.capability).toBeDefined();
      expect(CAPABILITY_SCOPES).toContain(cap!.auth.scope);
    }
  });
});
