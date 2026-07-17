import { describe, expect, it } from "vitest";

import {
  WebhookConfigError,
  WebhookTargetUnreachableError,
  WebhookUnexpectedResponseError,
} from "./errors.js";
import { WebhookClient, type WebhookClientOptions } from "./client.js";

const API_KEY = "whk_client_test_key_abcdefgh";

interface Call {
  url: string;
  method: string;
  body: string | undefined;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recorder(queue: Response[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (url: unknown, init: unknown) => {
    const i = (init ?? {}) as RequestInit;
    calls.push({
      url: String(url),
      method: String(i.method),
      body: i.body === undefined ? undefined : String(i.body),
    });
    const next = queue[calls.length - 1];
    if (next === undefined) throw new Error("recorder: unexpected extra call");
    return next;
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

function make(
  queue: Response[],
  opts: Partial<WebhookClientOptions> = {},
): { client: WebhookClient; calls: Call[] } {
  const { fetch: fetchFn, calls } = recorder(queue);
  const client = new WebhookClient({
    apiKey: API_KEY,
    fetch: fetchFn,
    sleep: async () => {},
    rand: () => 0,
    timeoutSignal: () => new AbortController().signal,
    ...opts,
  });
  return { client, calls };
}

describe("WebhookClient constructor", () => {
  it("throws on a missing API key", () => {
    expect(() => new WebhookClient({ apiKey: "" })).toThrow(WebhookConfigError);
  });

  it("throws on a plaintext non-loopback base URL", () => {
    expect(() => new WebhookClient({ apiKey: API_KEY, baseUrl: "http://api.webhook.co" })).toThrow(
      WebhookConfigError,
    );
  });

  it("throws when no fetch implementation is available and none is passed", () => {
    const original = globalThis.fetch;
    // @ts-expect-error simulate a runtime with no global fetch
    delete globalThis.fetch;
    try {
      expect(() => new WebhookClient({ apiKey: API_KEY })).toThrow(WebhookConfigError);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("uses globalThis.fetch by default", async () => {
    const { fetch: spy, calls } = recorder([json(200, { orgId: "o1", scopes: [] })]);
    const original = globalThis.fetch;
    globalThis.fetch = spy;
    try {
      const client = new WebhookClient({ apiKey: API_KEY });
      await client.whoami();
      expect(calls).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("whoami", () => {
  it("GETs /v1/whoami and returns the identity", async () => {
    const { client, calls } = make([json(200, { orgId: "o1", scopes: ["endpoints:read"] })]);
    const me = await client.whoami();
    expect(me.orgId).toBe("o1");
    expect(calls[0]).toMatchObject({ url: "https://api.webhook.co/v1/whoami", method: "GET" });
  });
});

describe("endpoints", () => {
  it("get() reads a single endpoint by id (url-encoded)", async () => {
    const { client, calls } = make([json(200, { id: "e 1" })]);
    await client.endpoints.get("e 1");
    expect(calls[0]!.url).toBe("https://api.webhook.co/v1/endpoints/e%201");
    expect(calls[0]!.method).toBe("GET");
  });

  it("create() POSTs the name and is NOT retried on a transient failure", async () => {
    const { client, calls } = make([json(502, { error: "TARGET_UNREACHABLE", message: "x" })]);
    await expect(client.endpoints.create({ name: "prod" })).rejects.toBeInstanceOf(
      WebhookTargetUnreachableError,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://api.webhook.co/v1/endpoints",
      method: "POST",
      body: JSON.stringify({ name: "prod" }),
    });
  });

  it("delete() is idempotent (retried on a transient failure)", async () => {
    const { client, calls } = make([
      json(502, { error: "TARGET_UNREACHABLE", message: "x" }),
      json(200, { id: "e1", deletedAt: "t" }),
    ]);
    await client.endpoints.delete("e1");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe("DELETE");
  });

  it("update() PATCHes the dedup config and IS retried (same config → same result)", async () => {
    const { client, calls } = make([
      json(502, { error: "TARGET_UNREACHABLE", message: "x" }),
      json(200, { id: "e1", dedupConfig: null }),
    ]);
    await client.endpoints.update("e1", { dedupConfig: null });
    expect(calls).toHaveLength(2); // idempotent → a transient failure is retried
    expect(calls[0]).toMatchObject({
      url: "https://api.webhook.co/v1/endpoints/e1",
      method: "PATCH",
      body: JSON.stringify({ dedupConfig: null }),
    });
  });

  // The URL is sealed at rest (ADR-0101) — reveal is how you RECOVER a forgotten one. Rotating instead
  // would revoke a live credential and break every sender still posting to the old URL.
  it("revealIngestUrl() POSTs with no body and is NOT retried (a blind retry would double-audit)", async () => {
    const { client, calls } = make([json(502, { error: "TARGET_UNREACHABLE", message: "x" })]);
    await expect(client.endpoints.revealIngestUrl("e1")).rejects.toBeInstanceOf(
      WebhookTargetUnreachableError,
    );
    expect(calls).toHaveLength(1); // every disclosure writes a tamper-evident audit row
    expect(calls[0]).toMatchObject({
      url: "https://api.webhook.co/v1/endpoints/e1/reveal-ingest-url",
      method: "POST",
      body: undefined,
    });
  });

  it("revealIngestUrl() returns a null ingestUrl for an endpoint predating sealed storage", async () => {
    const { client } = make([json(200, { ingestUrl: null })]);
    await expect(client.endpoints.revealIngestUrl("e1")).resolves.toEqual({ ingestUrl: null });
  });

  it("rotate() POSTs to /rotate with no body and is not retried", async () => {
    const { client, calls } = make([json(502, { error: "TARGET_UNREACHABLE", message: "x" })]);
    await expect(client.endpoints.rotate("e1")).rejects.toBeInstanceOf(
      WebhookTargetUnreachableError,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://api.webhook.co/v1/endpoints/e1/rotate",
      method: "POST",
      body: undefined,
    });
  });

  it("list() auto-paginates across pages", async () => {
    const { client } = make([
      json(200, { items: [{ id: "a" }, { id: "b" }], nextCursor: "c1" }),
      json(200, { items: [{ id: "c" }], nextCursor: null }),
    ]);
    const ids: string[] = [];
    for await (const ep of client.endpoints.list()) ids.push(ep.id);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("list() threads filters + the rolling cursor into the query", async () => {
    const { client, calls } = make([json(200, { items: [], nextCursor: null })]);
    await client.endpoints.list({ name: "prod", limit: 10 }).collect();
    expect(calls[0]!.url).toBe("https://api.webhook.co/v1/endpoints?limit=10&name=prod");
  });

  it("listPage() returns one page with its cursor", async () => {
    const { client } = make([json(200, { items: [{ id: "a" }], nextCursor: "next" })]);
    const page = await client.endpoints.listPage({ limit: 1 });
    expect(page.nextCursor).toBe("next");
    expect(page.items).toHaveLength(1);
  });

  it("providerSecrets.add() includes optional fields only when set (NOT idempotent)", async () => {
    const { client, calls } = make([json(200, { id: "ps1" })]);
    await client.endpoints.providerSecrets.add({
      endpointId: "e1",
      provider: "stripe",
      secret: "whsec_x",
    });
    expect(calls[0]!.body).toBe(JSON.stringify({ provider: "stripe", secret: "whsec_x" }));
    expect(calls[0]!.url).toBe("https://api.webhook.co/v1/endpoints/e1/provider-secrets");
  });

  it("providerSecrets.add() carries label + kind when provided", async () => {
    const { client, calls } = make([json(200, { id: "ps1" })]);
    await client.endpoints.providerSecrets.add({
      endpointId: "e1",
      provider: "stripe",
      secret: "whsec_x",
      label: "prod key",
      kind: "verify_token",
    });
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      provider: "stripe",
      secret: "whsec_x",
      label: "prod key",
      kind: "verify_token",
    });
  });

  it("providerSecrets.add() accepts and forwards the braintree_public_key kind", async () => {
    const { client, calls } = make([json(200, { id: "ps1" })]);
    await client.endpoints.providerSecrets.add({
      endpointId: "e1",
      provider: "braintree",
      secret: "pk_x",
      kind: "braintree_public_key",
    });
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      provider: "braintree",
      secret: "pk_x",
      kind: "braintree_public_key",
    });
  });

  it("providerSecrets.list() unwraps the items array", async () => {
    const { client } = make([json(200, { items: [{ id: "ps1" }, { id: "ps2" }] })]);
    const secrets = await client.endpoints.providerSecrets.list("e1");
    expect(secrets).toHaveLength(2);
  });

  it("providerSecrets.revoke() DELETEs and is NOT retried", async () => {
    const { client, calls } = make([json(502, { error: "TARGET_UNREACHABLE", message: "x" })]);
    await expect(
      client.endpoints.providerSecrets.revoke({ endpointId: "e1", secretId: "ps1" }),
    ).rejects.toBeInstanceOf(WebhookTargetUnreachableError);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.webhook.co/v1/endpoints/e1/provider-secrets/ps1");
  });
});

describe("events", () => {
  it("list() builds the full filter query with repeated multi-selects (canonical route)", async () => {
    const { client, calls } = make([json(200, { items: [], nextCursor: null })]);
    await client.events
      .list({
        endpointId: "e1",
        provider: ["stripe", "github"],
        verificationState: ["verified"],
        receivedAfter: "2026-01-01T00:00:00Z",
        search: "checkout",
        method: ["GET", "POST"],
        limit: 25,
      })
      .collect();
    const url = calls[0]!.url;
    expect(url).toContain("/v1/events?");
    expect(url).toContain("endpointId=e1");
    expect(url).toContain("provider=stripe&provider=github");
    expect(url).toContain("verificationState=verified");
    expect(url).toContain("receivedAfter=2026-01-01T00%3A00%3A00Z");
    expect(url).toContain("search=checkout");
    expect(url).toContain("method=GET&method=POST");
    expect(url).toContain("limit=25");
  });

  it("get() reads a single event", async () => {
    const { client, calls } = make([json(200, { id: "ev1" })]);
    await client.events.get("ev1");
    expect(calls[0]!.url).toBe("https://api.webhook.co/v1/events/ev1");
  });

  it("listPage() hits the canonical /v1/events, org-wide by default", async () => {
    const { client, calls } = make([json(200, { items: [{ id: "ev1" }], nextCursor: "n" })]);
    const page = await client.events.listPage({ limit: 1, search: "xyz" });
    expect(page.nextCursor).toBe("n");
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe("/v1/events");
    expect(u.searchParams.has("endpointId")).toBe(false);
    expect(u.searchParams.get("search")).toBe("xyz");
  });

  it("listPage({ endpointId }) drills into one endpoint via ?endpointId= (still canonical)", async () => {
    const { client, calls } = make([json(200, { items: [], nextCursor: null })]);
    await client.events.listPage({
      endpointId: "e1",
      method: ["GET", "POST"],
      dedupStrategy: ["unique"],
      eventType: "charge.succeeded",
    });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe("/v1/events");
    expect(u.searchParams.get("endpointId")).toBe("e1");
    expect(u.searchParams.getAll("method")).toEqual(["GET", "POST"]);
    expect(u.searchParams.get("dedupStrategy")).toBe("unique");
    expect(u.searchParams.get("eventType")).toBe("charge.succeeded");
  });

  it("listPageByEndpoint() hits the DEPRECATED nested route", async () => {
    const { client, calls } = make([json(200, { items: [], nextCursor: null })]);
    await client.events.listPageByEndpoint("e1", { limit: 1 });
    expect(new URL(calls[0]!.url).pathname).toBe("/v1/endpoints/e1/events");
  });

  it("list()/listPage() reject a legacy string endpointId arg with a migration error (JS-caller footgun)", () => {
    const { client } = make([]);
    // An UNTYPED JS caller still passing `list('ep_123')` must get a loud error, not a silent whole-org list.
    const list = client.events.list as unknown as (a: unknown) => unknown;
    const listPage = client.events.listPage as unknown as (a: unknown) => unknown;
    expect(() => list.call(client.events, "ep_123")).toThrow(/no longer takes an endpoint id/);
    expect(() => listPage.call(client.events, "ep_123")).toThrow(/no longer takes an endpoint id/);
  });

  it("list()/listPage() reject an EMPTY endpointId rather than silently listing the whole org", () => {
    const { client } = make([]);
    // `{ endpointId: "" }` (unset env var / blank config) must fail fast, not silently widen to org-wide.
    expect(() => client.events.list({ endpointId: "" })).toThrow(/endpointId is an empty string/);
    expect(() => client.events.listPage({ endpointId: "  " })).toThrow(
      /endpointId is an empty string/,
    );
  });

  it("listByEndpoint() rejects an endpointId ALSO placed in filters (it would be silently ignored)", () => {
    const { client } = make([]);
    // The positional is authoritative; a filters.endpointId would be dropped, scoping the wrong endpoint.
    expect(() => client.events.listByEndpoint("ep_1", { endpointId: "ep_2" })).toThrow(
      /don't also set it in filters/,
    );
    expect(() => client.events.listPageByEndpoint("ep_1", { endpointId: "ep_2" })).toThrow(
      /don't also set it in filters/,
    );
    // And an empty positional id fails fast rather than building /v1/endpoints//events.
    expect(() => client.events.listByEndpoint("")).toThrow(/must be a non-empty endpoint id/);
  });

  it("getPayload() decodes the base64 envelope to bytes", async () => {
    const { client } = make([
      json(200, { contentType: "application/json", bytes: 5, bodyBase64: "aGVsbG8=" }),
    ]);
    const { contentType, body } = await client.events.getPayload("ev1");
    expect(contentType).toBe("application/json");
    expect([...body]).toEqual([104, 101, 108, 108, 111]);
  });

  it("getPayload() rejects a corrupted (length-mismatched) envelope", async () => {
    const { client } = make([json(200, { contentType: null, bytes: 999, bodyBase64: "aGVsbG8=" })]);
    await expect(client.events.getPayload("ev1")).rejects.toBeInstanceOf(
      WebhookUnexpectedResponseError,
    );
  });

  it("tail() polls with sinceCursor/since query params", async () => {
    const { client, calls } = make([json(200, { items: [], nextCursor: null })]);
    await client.events.tail("e1", { since: "now", sinceCursor: "cur" });
    expect(calls[0]!.url).toBe(
      "https://api.webhook.co/v1/endpoints/e1/events/tail?sinceCursor=cur&since=now",
    );
  });

  it("replay() POSTs the target + idempotencyKey and IS retried (idempotency-keyed)", async () => {
    const { client, calls } = make([
      json(502, { error: "TARGET_UNREACHABLE", message: "x" }),
      json(200, { id: "att1" }),
    ]);
    await client.events.replay({
      eventId: "ev1",
      target: { kind: "localhost-tunnel", sessionId: "s1" },
      idempotencyKey: "idem-1",
    });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      target: { kind: "localhost-tunnel", sessionId: "s1" },
      idempotencyKey: "idem-1",
    });
  });
});

describe("events.delete / usage / triggers", () => {
  it("events.delete() DELETEs and IS retried (re-deleting is a no-op)", async () => {
    const { client, calls } = make([
      json(502, { error: "TARGET_UNREACHABLE", message: "x" }),
      json(200, { id: "ev1", deletedAt: "2026-07-13T00:00:00.000Z" }),
    ]);
    await client.events.delete("ev1");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      url: "https://api.webhook.co/v1/events/ev1",
      method: "DELETE",
    });
  });

  it("usage.get() GETs /v1/usage", async () => {
    const { client, calls } = make([
      json(200, {
        periodStart: "2026-07-01T00:00:00.000Z",
        periodEnd: null,
        capKind: "lifetime",
        events: 12,
        eventCap: 5000,
        pausePolicy: "pause",
        paused: false,
      }),
    ]);
    const usage = await client.usage.get();
    expect(usage.events).toBe(12);
    expect(calls[0]).toMatchObject({ url: "https://api.webhook.co/v1/usage", method: "GET" });
  });

  it("triggers.create() POSTs the body and is NOT retried (each call mints a trigger)", async () => {
    const { client, calls } = make([json(502, { error: "TARGET_UNREACHABLE", message: "x" })]);
    await expect(
      client.triggers.create({ endpointId: "e1", name: "orders" }),
    ).rejects.toBeInstanceOf(WebhookTargetUnreachableError);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://api.webhook.co/v1/triggers",
      method: "POST",
      body: JSON.stringify({ endpointId: "e1", name: "orders" }),
    });
  });

  it("triggers.list() passes the optional endpointId filter as a query param", async () => {
    const { client, calls } = make([json(200, { items: [] })]);
    await client.triggers.list({ endpointId: "e1" });
    expect(calls[0]!.url).toBe("https://api.webhook.co/v1/triggers?endpointId=e1");
  });

  it("triggers.revoke() DELETEs and is idempotent", async () => {
    const { client, calls } = make([json(200, { id: "t1" })]);
    await client.triggers.revoke("t1");
    expect(calls[0]).toMatchObject({
      url: "https://api.webhook.co/v1/triggers/t1",
      method: "DELETE",
    });
  });

  // The ack-by-cursor loop from the docstring must actually typecheck and run: a caught-up page returns
  // nextCursor: null, and the contract makes the input nullable so THAT value feeds straight back in. If
  // null serialised as "null" the server would reject it as a malformed cursor.
  it("triggers.wait() round-trips a caught-up nextCursor (null) back in without sending cursor=null", async () => {
    const { client, calls } = make([
      json(200, { events: [{ id: "ev1" }], nextCursor: "c1", caughtUp: false }),
      json(200, { events: [], nextCursor: null, caughtUp: true }),
      json(200, { events: [], nextCursor: null, caughtUp: true }),
    ]);
    let cursor: string | null = null;
    const seen: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const page = await client.triggers.wait("t1", { cursor });
      seen.push(...page.events);
      cursor = page.nextCursor; // null once caught up — must be accepted on the next call
    }
    expect(seen).toHaveLength(1);
    // 1st call: no cursor (null start). 2nd: the real cursor. 3rd: null again -> omitted, NOT "cursor=null".
    expect(new URL(calls[0]!.url).searchParams.has("cursor")).toBe(false);
    expect(new URL(calls[1]!.url).searchParams.get("cursor")).toBe("c1");
    expect(calls[2]!.url).not.toContain("cursor");
  });

  it("triggers.wait() sends the cursor/limit/includeBody/maxBodyBytes query params", async () => {
    const { client, calls } = make([json(200, { events: [], nextCursor: null, caughtUp: true })]);
    await client.triggers.wait("t1", {
      cursor: "c1",
      limit: 10,
      includeBody: true,
      maxBodyBytes: 4096,
    });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe("/v1/triggers/t1/wait");
    expect(u.searchParams.get("cursor")).toBe("c1");
    expect(u.searchParams.get("limit")).toBe("10");
    expect(u.searchParams.get("includeBody")).toBe("true");
    expect(u.searchParams.get("maxBodyBytes")).toBe("4096");
  });
});

describe("deliveries", () => {
  it("list() threads destination/subscription/status filters", async () => {
    const { client, calls } = make([json(200, { items: [], nextCursor: null })]);
    await client.deliveries
      .list({ destinationId: "d1", status: ["failed", "delivered"] })
      .collect();
    const url = calls[0]!.url;
    expect(url).toContain("destinationId=d1");
    expect(url).toContain("status=failed&status=delivered");
  });

  it("get() reads a single delivery", async () => {
    const { client, calls } = make([json(200, { id: "del1" })]);
    await client.deliveries.get("del1");
    expect(calls[0]!.url).toBe("https://api.webhook.co/v1/deliveries/del1");
  });

  it("listPage() returns one page with its cursor", async () => {
    const { client } = make([json(200, { items: [{ id: "del1" }], nextCursor: "n" })]);
    const page = await client.deliveries.listPage({ status: ["failed"] });
    expect(page.nextCursor).toBe("n");
    expect(page.items).toHaveLength(1);
  });
});

describe("replayDestinations", () => {
  it("create() POSTs url (+ optional label) and is idempotent (retried)", async () => {
    const { client, calls } = make([
      json(502, { error: "TARGET_UNREACHABLE", message: "x" }),
      json(200, { id: "d1" }),
    ]);
    await client.replayDestinations.create({ url: "https://ex.test/hook", label: "prod" });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ url: "https://ex.test/hook", label: "prod" });
  });

  it("list() unwraps items", async () => {
    const { client } = make([json(200, { items: [{ id: "d1" }] })]);
    expect(await client.replayDestinations.list()).toHaveLength(1);
  });

  it("delete() DELETEs and is NOT retried", async () => {
    const { client, calls } = make([json(502, { error: "TARGET_UNREACHABLE", message: "x" })]);
    await expect(client.replayDestinations.delete("d1")).rejects.toBeInstanceOf(
      WebhookTargetUnreachableError,
    );
    expect(calls).toHaveLength(1);
  });

  it("enable() POSTs an empty body and is NOT retried", async () => {
    const { client, calls } = make([json(502, { error: "TARGET_UNREACHABLE", message: "x" })]);
    await expect(client.replayDestinations.enable("d1")).rejects.toBeInstanceOf(
      WebhookTargetUnreachableError,
    );
    expect(calls[0]).toMatchObject({
      url: "https://api.webhook.co/v1/replay-destinations/d1/enable",
      method: "POST",
      body: "{}",
    });
  });

  it("setOrdered() POSTs {ordered} and is idempotent", async () => {
    const { client, calls } = make([
      json(502, { error: "TARGET_UNREACHABLE", message: "x" }),
      json(200, { id: "d1" }),
    ]);
    await client.replayDestinations.setOrdered("d1", true);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toBe(JSON.stringify({ ordered: true }));
  });

  it("rotateSigningSecret() POSTs an empty body and is NOT retried", async () => {
    const { client, calls } = make([json(502, { error: "TARGET_UNREACHABLE", message: "x" })]);
    await expect(client.replayDestinations.rotateSigningSecret("d1")).rejects.toBeInstanceOf(
      WebhookTargetUnreachableError,
    );
    expect(calls[0]!.url).toBe("https://api.webhook.co/v1/replay-destinations/d1/signing-secret");
  });

  it("listSigningSecrets() unwraps items", async () => {
    const { client } = make([json(200, { items: [{ id: "k1" }, { id: "k2" }] })]);
    expect(await client.replayDestinations.listSigningSecrets("d1")).toHaveLength(2);
  });
});

describe("subscriptions", () => {
  it("create() includes optional fields only when set (NOT idempotent)", async () => {
    const { client, calls } = make([json(502, { error: "TARGET_UNREACHABLE", message: "x" })]);
    await expect(
      client.subscriptions.create({ sourceEndpointId: "e1", destinationId: "d1" }),
    ).rejects.toBeInstanceOf(WebhookTargetUnreachableError);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ sourceEndpointId: "e1", destinationId: "d1" });
  });

  it("create() carries provider/eventTypes/requireVerified when provided", async () => {
    const { client, calls } = make([json(200, { id: "sub1" })]);
    await client.subscriptions.create({
      sourceEndpointId: "e1",
      destinationId: "d1",
      provider: "stripe",
      eventTypes: ["a", "b"],
      requireVerified: true,
    });
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      sourceEndpointId: "e1",
      destinationId: "d1",
      provider: "stripe",
      eventTypes: ["a", "b"],
      requireVerified: true,
    });
  });

  it("list() filters by source endpoint and unwraps items", async () => {
    const { client, calls } = make([json(200, { items: [{ id: "sub1" }] })]);
    const subs = await client.subscriptions.list("e1");
    expect(subs).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.webhook.co/v1/subscriptions?sourceEndpointId=e1");
  });

  it("delete() DELETEs and is NOT retried", async () => {
    const { client, calls } = make([json(502, { error: "TARGET_UNREACHABLE", message: "x" })]);
    await expect(client.subscriptions.delete("sub1")).rejects.toBeInstanceOf(
      WebhookTargetUnreachableError,
    );
    expect(calls).toHaveLength(1);
  });
});

describe("audit", () => {
  it("verify() POSTs /v1/audit/verify with no body and is idempotent", async () => {
    const { client, calls } = make([
      json(502, { error: "TARGET_UNREACHABLE", message: "x" }),
      json(200, { ok: true, rowsVerified: 3 }),
    ]);
    await client.audit.verify();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      url: "https://api.webhook.co/v1/audit/verify",
      method: "POST",
      body: undefined,
    });
  });
});

// The whole server-driven loop, end to end through the real client: we identify ourselves, the server rides
// an advisory on a response we already asked for, and we surface it ONCE.
describe("client version advisory (end to end)", () => {
  const advisoryResponse = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-webhook-advisory": "update-available; current=0.0.0; latest=9.9.9",
      },
    });

  it("sends a versioned user-agent so the server can recognise this client", async () => {
    const calls: Array<Record<string, string>> = [];
    const fetchFn = (async (_url: unknown, init: unknown) => {
      calls.push((init as { headers: Record<string, string> }).headers);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = new WebhookClient({ apiKey: API_KEY, fetch: fetchFn });
    await client.whoami();
    expect(calls[0]!["user-agent"]).toMatch(/^webhook-co-js\/\d+\.\d+\.\d+ \(/);
  });

  it("surfaces the server's advisory to onAdvisory exactly once across many requests", async () => {
    const seen: unknown[] = [];
    const fetchFn = (async () => advisoryResponse({})) as unknown as typeof fetch;
    const client = new WebhookClient({
      apiKey: API_KEY,
      fetch: fetchFn,
      onAdvisory: (a) => seen.push(a),
    });
    await client.whoami();
    await client.whoami();
    await client.whoami();
    expect(seen).toHaveLength(1); // once per client, NOT once per request
    expect(seen[0]).toMatchObject({ current: "0.0.0", latest: "9.9.9", deprecated: false });
  });

  it("stays silent when the server sends no advisory (the common case)", async () => {
    const seen: unknown[] = [];
    const fetchFn = (async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const client = new WebhookClient({
      apiKey: API_KEY,
      fetch: fetchFn,
      onAdvisory: (a) => seen.push(a),
    });
    await client.whoami();
    expect(seen).toHaveLength(0);
  });

  it("can be silenced completely", async () => {
    const seen: unknown[] = [];
    const fetchFn = (async () => advisoryResponse({})) as unknown as typeof fetch;
    const client = new WebhookClient({
      apiKey: API_KEY,
      fetch: fetchFn,
      onAdvisory: (a) => seen.push(a),
      silenceAdvisories: true,
    });
    await client.whoami();
    expect(seen).toHaveLength(0);
  });
});
