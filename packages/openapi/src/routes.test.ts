import { CAPABILITIES, CAPABILITY_REGISTRY, requiredSurfaces } from "@webhook-co/contract";
import { describe, expect, it } from "vitest";

import { ROUTES, matchRoute, pathParamNames, type RouteDef, type DispatchKind } from "./routes.js";

const EP = "44444444-4444-7444-8444-444444444444";
const SID = "88888888-8888-7888-8888-888888888888";
const DEST = "55555555-5555-7555-8555-555555555555";
const SUB = "66666666-6666-7666-8666-666666666666";

/** Split a request path the way the worker does (url.pathname.split("/").filter(Boolean)). */
function segs(path: string): string[] {
  return path
    .split("?")[0]
    .split("/")
    .filter((s) => s.length > 0);
}
function query(path: string): URLSearchParams {
  return new URL(`https://api.webhook.co${path}`).searchParams;
}
function match(method: string, path: string) {
  return matchRoute(method, segs(path), query(path));
}

const VALID_DISPATCH: readonly DispatchKind[] = [
  "shared",
  "payload",
  "replay",
  "replayDestinations",
  "subscriptions",
  "whoami",
];

describe("ROUTES manifest — the single source of HTTP truth", () => {
  it("binds exactly one route per API-surface capability (bijection, no gaps, no dupes)", () => {
    const apiCapabilities = CAPABILITIES.filter((c) => requiredSurfaces(c).includes("api"))
      .map((c) => c.name)
      .sort();
    const routeCapabilities = ROUTES.map((r) => r.capability)
      .filter((c): c is string => c !== null)
      .sort();
    // No capability is bound twice.
    expect(new Set(routeCapabilities).size).toBe(routeCapabilities.length);
    // Every API capability has a route, and every capability-route names a real capability.
    expect(routeCapabilities).toEqual(apiCapabilities);
  });

  it("includes the scope-free whoami identity route (capability null, dispatch whoami)", () => {
    const whoami = ROUTES.filter((r) => r.dispatch === "whoami");
    expect(whoami).toHaveLength(1);
    expect(whoami[0]).toMatchObject({ method: "GET", path: "/v1/whoami", capability: null });
  });

  it("every capability route names a capability in the registry", () => {
    for (const r of ROUTES) {
      if (r.capability !== null) expect(CAPABILITY_REGISTRY.has(r.capability)).toBe(true);
    }
  });

  it("every route succeeds with 200 and carries a valid dispatch kind (no 201/204 leak)", () => {
    for (const r of ROUTES) {
      expect(r.successStatus).toBe(200);
      expect(VALID_DISPATCH).toContain(r.dispatch);
      expect(["GET", "POST", "DELETE"]).toContain(r.method);
      expect(r.path.startsWith("/v1/")).toBe(true);
      expect(r.summary.length).toBeGreaterThan(0);
    }
  });

  it("every declared path param appears in the template exactly once", () => {
    for (const r of ROUTES) {
      const names = pathParamNames(r.path);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("no request path matches two routes (no template ambiguity)", () => {
    // Materialize a concrete path from each template and assert it resolves back to that same route.
    for (const r of ROUTES) {
      const concrete = r.path.replace(/\{(\w+)\}/g, "11111111-1111-7111-8111-111111111111");
      const m = match(r.method, concrete);
      expect(m, `no match for ${r.method} ${concrete}`).not.toBeNull();
      expect(m?.def.path).toBe(r.path);
      expect(m?.def.method).toBe(r.method);
    }
  });
});

describe("matchRoute — routing + input construction (ported behavior)", () => {
  it("GET /v1/endpoints → endpoints.list, pagination from the query", () => {
    const m = match("GET", "/v1/endpoints?limit=10&cursor=abc.def");
    expect(m?.def.capability).toBe("endpoints.list");
    expect(m?.input).toEqual({ limit: 10, cursor: "abc.def" });
  });

  it("GET /v1/endpoints?name=acme → name filter; empty ?name= is dropped", () => {
    expect(match("GET", "/v1/endpoints?name=acme")?.input).toEqual({ filter: { name: "acme" } });
    expect(match("GET", "/v1/endpoints?name=")?.input).toEqual({});
  });

  it("GET /v1/endpoints/:id/events → events.list with a multi-select provider filter", () => {
    const m = match("GET", `/v1/endpoints/${EP}/events?provider=stripe&provider=github`);
    expect(m?.def.capability).toBe("events.list");
    expect(m?.input).toEqual({ endpointId: EP, filter: { provider: ["stripe", "github"] } });
  });

  it("events.list builds the full filter from raw query strings", () => {
    const m = match(
      "GET",
      `/v1/endpoints/${EP}/events?provider=github&verificationState=failed&receivedAfter=2026-06-01T00:00:00Z&receivedBefore=2026-06-02T00:00:00Z&search=evt_abc`,
    );
    expect(m?.input).toEqual({
      endpointId: EP,
      filter: {
        provider: ["github"],
        verificationState: ["failed"],
        receivedAfter: "2026-06-01T00:00:00Z",
        receivedBefore: "2026-06-02T00:00:00Z",
        search: "evt_abc",
      },
    });
  });

  it("events.list drops empty/whitespace filter params (cleared filters, not a 400)", () => {
    expect(match("GET", `/v1/endpoints/${EP}/events?provider=&receivedAfter=`)?.input).toEqual({
      endpointId: EP,
    });
    expect(match("GET", `/v1/endpoints/${EP}/events?search=%20%20`)?.input).toEqual({
      endpointId: EP,
    });
  });

  it("GET /v1/endpoints/:id/events/tail → events.tail (?since grammar + ?sinceCursor)", () => {
    expect(match("GET", `/v1/endpoints/${EP}/events/tail?since=2h`)?.input).toEqual({
      endpointId: EP,
      since: "2h",
    });
    expect(match("GET", `/v1/endpoints/${EP}/events/tail?sinceCursor=abc.def`)?.input).toEqual({
      endpointId: EP,
      sinceCursor: "abc.def",
    });
    expect(match("GET", `/v1/endpoints/${EP}/events/tail`)?.input).toEqual({ endpointId: EP });
  });

  it("GET /v1/deliveries → deliveries.list with multi-select status + filters", () => {
    const m = match(
      "GET",
      `/v1/deliveries?destinationId=${DEST}&subscriptionId=${SUB}&status=delivered&status=dead&limit=5`,
    );
    expect(m?.def.capability).toBe("deliveries.list");
    expect(m?.input).toEqual({
      limit: 5,
      destinationId: DEST,
      subscriptionId: SUB,
      status: ["delivered", "dead"],
    });
  });

  it("deliveries.list treats empty ?status=/?destinationId= as no filter", () => {
    expect(match("GET", "/v1/deliveries?status=&destinationId=")?.input).toEqual({});
  });

  it("nested + path-param routes carry the right ids", () => {
    expect(match("DELETE", `/v1/endpoints/${EP}/provider-secrets/${SID}`)?.input).toEqual({
      endpointId: EP,
      secretId: SID,
    });
    expect(match("GET", `/v1/deliveries/${DEST}`)?.input).toEqual({ deliveryId: DEST });
    expect(match("POST", `/v1/endpoints/${EP}/rotate`)?.def.capability).toBe("endpoints.rotate");
  });

  it("subscriptions.list carries the optional sourceEndpointId filter", () => {
    expect(match("GET", `/v1/subscriptions?sourceEndpointId=${EP}`)?.input).toEqual({
      sourceEndpointId: EP,
    });
    expect(match("GET", "/v1/subscriptions")?.input).toEqual({});
  });

  it("body-bearing routes are flagged and derive their path input", () => {
    const create = match("POST", "/v1/endpoints");
    expect(create?.def.capability).toBe("endpoints.create");
    expect(create?.def.body).toBe(true);
    expect(create?.input).toEqual({});
    const addSecret = match("POST", `/v1/endpoints/${EP}/provider-secrets`);
    expect(addSecret?.def.body).toBe(true);
    expect(addSecret?.input).toEqual({ endpointId: EP });
  });

  it("GET /v1/whoami resolves to the identity route", () => {
    const m = match("GET", "/v1/whoami");
    expect(m?.def.dispatch).toBe("whoami");
    expect(m?.def.capability).toBeNull();
  });

  it("returns null for an unknown path or a non-/v1 prefix", () => {
    expect(match("GET", "/v1/nonsense")).toBeNull();
    expect(match("GET", "/v2/endpoints")).toBeNull();
    expect(match("GET", "/")).toBeNull();
    expect(match("PUT", "/v1/endpoints")).toBeNull();
  });
});

describe("pathParamNames", () => {
  it("extracts placeholder names in order", () => {
    expect(pathParamNames("/v1/endpoints/{endpointId}/provider-secrets/{secretId}")).toEqual([
      "endpointId",
      "secretId",
    ]);
    expect(pathParamNames("/v1/whoami")).toEqual([]);
  });
});

// A compile-time-ish guard that RouteDef stays structurally what the generator/router rely on.
const _sample: RouteDef | undefined = ROUTES[0];
void _sample;
