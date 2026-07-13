import { describe, expect, it } from "vitest";

import { WebhookClient, type WebhookClientOptions } from "./client.js";
import spec from "../../openapi/src/openapi.json" with { type: "json" };

/**
 * The SDK route-coverage RATCHET.
 *
 * Every route in the OpenAPI spec MUST be reachable from a public SDK method — or be listed in EXEMPTIONS
 * with a reason. This exists because NOTHING enforced SDK coverage: `endpoints.revealIngestUrl` shipped on
 * the api, cli and mcp surfaces, but no SDK ever got a method, so "the ingest URL is re-readable" stayed
 * accidentally FALSE for SDK users — and the stale "capture it now" docs stayed accidentally TRUE. The
 * contract's parity.test.ts only covers SURFACES = api|cli|mcp|web; the SDKs are not surfaces.
 *
 * Coverage here is EXECUTABLE, not declared: each covered route maps to a thunk that actually CALLS the SDK
 * method, and the test asserts the request really landed on that route with that HTTP method. A hand-kept
 * list of "routes we cover" can lie (add the route, forget the method); a thunk that must issue the request
 * cannot. Writing this list by hand is exactly how it would have gone wrong — three of the routes I first
 * assumed (`/v1/events/tail`, `GET /v1/replay-destinations/{id}`, `.../rotate-signing-secret`) do not exist.
 *
 * A ratchet, not a snapshot: EXEMPTIONS entries may be DELETED as they get implemented. Adding one requires
 * a conscious, reviewed reason — and a new spec route with neither a thunk nor an exemption fails CI.
 */

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

/** Every "METHOD /path/{template}" in the spec. */
function specRoutes(): string[] {
  const out: string[] = [];
  for (const [path, item] of Object.entries(
    spec.paths as Record<string, Record<string, unknown>>,
  )) {
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.has(method)) out.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return out.sort();
}

/**
 * Routes with no SDK method yet. DELETE an entry as you implement it — never add one without a reason.
 *
 * EMPTY: the TS SDK now reaches every route in the spec. An entry here means shipping a route the SDK
 * cannot reach, which is how the reveal gap happened — add one only deliberately, with a follow-up to
 * remove it.
 */
const EXEMPTIONS: Record<string, string> = {};

const ID = "11111111-1111-4111-8111-111111111111";

/**
 * One thunk per covered route: it must issue exactly one request, to that route, with that method. The
 * response body only has to be shape-valid enough for the method to return without throwing.
 */
const CALLS: Record<string, { body: unknown; call: (c: WebhookClient) => Promise<unknown> }> = {
  "GET /v1/endpoints": {
    body: { items: [], nextCursor: null },
    call: (c) => c.endpoints.listPage(),
  },
  "POST /v1/endpoints": { body: {}, call: (c) => c.endpoints.create({ name: "n" }) },
  "GET /v1/endpoints/{endpointId}": { body: {}, call: (c) => c.endpoints.get(ID) },
  "DELETE /v1/endpoints/{endpointId}": { body: {}, call: (c) => c.endpoints.delete(ID) },
  "POST /v1/endpoints/{endpointId}/rotate": { body: {}, call: (c) => c.endpoints.rotate(ID) },
  "PATCH /v1/endpoints/{endpointId}": {
    body: {},
    call: (c) => c.endpoints.update(ID, { dedupConfig: null }),
  },
  "POST /v1/endpoints/{endpointId}/reveal-ingest-url": {
    body: { ingestUrl: null },
    call: (c) => c.endpoints.revealIngestUrl(ID),
  },
  "POST /v1/endpoints/{endpointId}/provider-secrets": {
    body: {},
    call: (c) =>
      c.endpoints.providerSecrets.add({ endpointId: ID, provider: "stripe", secret: "s" }),
  },
  "GET /v1/endpoints/{endpointId}/provider-secrets": {
    body: { items: [] },
    call: (c) => c.endpoints.providerSecrets.list(ID),
  },
  "DELETE /v1/endpoints/{endpointId}/provider-secrets/{secretId}": {
    body: {},
    call: (c) => c.endpoints.providerSecrets.revoke({ endpointId: ID, secretId: ID }),
  },
  "GET /v1/endpoints/{endpointId}/events": {
    body: { items: [], nextCursor: null },
    call: (c) => c.events.listPage(ID),
  },
  "GET /v1/endpoints/{endpointId}/events/tail": {
    body: { events: [], nextCursor: null, headCursor: null, caughtUp: true },
    call: (c) => c.events.tail(ID),
  },
  "GET /v1/events/{eventId}": { body: {}, call: (c) => c.events.get(ID) },
  "GET /v1/events/{eventId}/payload": {
    body: { bodyBase64: "", contentType: "application/json", bytes: 0, truncated: false },
    call: (c) => c.events.getPayload(ID),
  },
  "POST /v1/events/{eventId}/replay": {
    body: {},
    call: (c) => c.events.replay({ eventId: ID, destinationId: ID, idempotencyKey: "k" }),
  },
  "GET /v1/deliveries": {
    body: { items: [], nextCursor: null },
    call: (c) => c.deliveries.listPage(),
  },
  "GET /v1/deliveries/{deliveryId}": { body: {}, call: (c) => c.deliveries.get(ID) },
  "POST /v1/replay-destinations": {
    body: {},
    call: (c) => c.replayDestinations.create({ url: "https://ex.test/h" }),
  },
  "GET /v1/replay-destinations": {
    body: { items: [] },
    call: (c) => c.replayDestinations.list(),
  },
  "DELETE /v1/replay-destinations/{destinationId}": {
    body: {},
    call: (c) => c.replayDestinations.delete(ID),
  },
  "POST /v1/replay-destinations/{destinationId}/enable": {
    body: {},
    call: (c) => c.replayDestinations.enable(ID),
  },
  "POST /v1/replay-destinations/{destinationId}/ordered": {
    body: {},
    call: (c) => c.replayDestinations.setOrdered(ID, true),
  },
  "POST /v1/replay-destinations/{destinationId}/signing-secret": {
    body: {},
    call: (c) => c.replayDestinations.rotateSigningSecret(ID),
  },
  "GET /v1/replay-destinations/{destinationId}/signing-secrets": {
    body: { items: [] },
    call: (c) => c.replayDestinations.listSigningSecrets(ID),
  },
  "POST /v1/subscriptions": {
    body: {},
    call: (c) => c.subscriptions.create({ sourceEndpointId: ID, destinationId: ID }),
  },
  "GET /v1/subscriptions": { body: { items: [] }, call: (c) => c.subscriptions.list() },
  "DELETE /v1/subscriptions/{subscriptionId}": {
    body: {},
    call: (c) => c.subscriptions.delete(ID),
  },
  "DELETE /v1/events/{eventId}": { body: {}, call: (c) => c.events.delete(ID) },
  "GET /v1/usage": {
    body: {
      periodStart: "2026-07-01T00:00:00.000Z",
      periodEnd: null,
      capKind: "lifetime",
      events: 0,
      eventCap: 5000,
      pausePolicy: "pause",
      paused: false,
    },
    call: (c) => c.usage.get(),
  },
  "GET /v1/triggers": { body: { items: [] }, call: (c) => c.triggers.list() },
  "POST /v1/triggers": { body: {}, call: (c) => c.triggers.create({ endpointId: ID }) },
  "DELETE /v1/triggers/{triggerId}": { body: {}, call: (c) => c.triggers.revoke(ID) },
  "GET /v1/triggers/{triggerId}/wait": {
    body: { events: [], nextCursor: null, caughtUp: true },
    call: (c) => c.triggers.wait(ID),
  },
  "POST /v1/audit/verify": { body: {}, call: (c) => c.audit.verify() },
  "GET /v1/whoami": { body: {}, call: (c) => c.whoami() },
};

/** `/v1/endpoints/{endpointId}/rotate` -> /^\/v1\/endpoints\/[^/]+\/rotate$/ */
function templateToRegex(path: string): RegExp {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{[^}]+\\\}/g, "[^/]+");
  return new RegExp(`^${escaped}$`);
}

function callClient(body: unknown): {
  client: WebhookClient;
  calls: { url: string; method: string }[];
} {
  const calls: { url: string; method: string }[] = [];
  const fetchFn = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), method: String((init as RequestInit).method) });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const options: WebhookClientOptions = {
    apiKey: "whk_spec_coverage_key_abcdefgh",
    fetch: fetchFn,
    sleep: async () => {},
    rand: () => 0,
    timeoutSignal: () => new AbortController().signal,
  };
  return { client: new WebhookClient(options), calls };
}

describe("sdk spec coverage (ratchet)", () => {
  it("every spec route has an SDK method, or an EXEMPTION with a reason", () => {
    const uncovered = specRoutes().filter((r) => !(r in CALLS) && !(r in EXEMPTIONS));
    expect(
      uncovered,
      `spec routes with no SDK method and no exemption:\n${uncovered.join("\n")}`,
    ).toEqual([]);
  });

  // Vacuity guards: neither table may name a route that no longer exists, or a real gap could hide behind a
  // stale entry — the failure mode that let the missing reveal method sit unnoticed.
  it("no CALLS or EXEMPTIONS entry names a route absent from the spec", () => {
    const routes = specRoutes();
    const stale = [...Object.keys(CALLS), ...Object.keys(EXEMPTIONS)].filter(
      (r) => !routes.includes(r),
    );
    expect(stale, `entries naming routes absent from the spec:\n${stale.join("\n")}`).toEqual([]);
  });

  // An exemption for a route we DO cover is worse than useless: it MASKS the coverage check for that route,
  // so deleting the method would not fail this suite. (Caught the hard way — a mutation test silently passed
  // because the route sat in both tables.) An exemption must mean "no method exists", nothing else.
  it("no route is both covered and exempted (a stale exemption masks a real gap)", () => {
    const both = Object.keys(CALLS).filter((r) => r in EXEMPTIONS);
    expect(
      both,
      `routes exempted despite having an SDK method — delete the exemption:\n${both.join("\n")}`,
    ).toEqual([]);
  });

  it("every exemption carries a non-empty reason", () => {
    const blank = Object.entries(EXEMPTIONS)
      .filter(([, reason]) => reason.trim() === "")
      .map(([route]) => route);
    expect(blank).toEqual([]);
  });

  // The teeth: claimed coverage must be REAL. Each thunk has to actually issue the request it claims.
  describe("each covered route is really reached by its SDK method", () => {
    for (const [route, { body, call }] of Object.entries(CALLS)) {
      it(route, async () => {
        const [method, path] = route.split(" ") as [string, string];
        const { client, calls } = callClient(body);
        await call(client);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.method).toBe(method);
        expect(new URL(calls[0]!.url).pathname).toMatch(templateToRegex(path));
      });
    }
  });
});
