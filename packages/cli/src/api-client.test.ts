import { bytesToB64 } from "@webhook-co/shared";
import { describe, expect, it } from "vitest";

import {
  ApiError,
  createApiClient,
  DEFAULT_API_BASE_URL,
  resolveApiBaseUrl,
} from "./api-client.js";
import { InvalidApiUrlError } from "./errors.js";
import { CAPABILITY_EXIT, EXIT } from "./output/exit-codes.js";

const BASE = "https://api.test.example";
const KEY = "whk_test_key";

/** A fake fetch returning a fixed Response; records the URL, headers, and method it was called with. */
function fakeFetch(res: Response): {
  fetch: typeof fetch;
  calls: { url: string; headers: Headers; method: string }[];
} {
  const calls: { url: string; headers: Headers; method: string }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: new Headers(init?.headers),
      method: init?.method ?? "GET",
    });
    return res;
  }) as unknown as typeof fetch;
  return { fetch, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createApiClient.whoami", () => {
  it("GETs {baseUrl}/v1/whoami with a Bearer header and returns the parsed identity", async () => {
    const identity = { orgId: "org_1", scopes: ["events:read"] };
    const { fetch, calls } = fakeFetch(json(identity));
    const client = createApiClient({ baseUrl: BASE, apiKey: KEY, fetch });
    expect(await client.whoami()).toEqual(identity);
    expect(calls[0].url).toBe(`${BASE}/v1/whoami`);
    expect(calls[0].headers.get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("maps 401 to an ApiError(UNAUTHORIZED) with the matching exit code", async () => {
    const { fetch } = fakeFetch(new Response(null, { status: 401 }));
    const client = createApiClient({ baseUrl: BASE, apiKey: KEY, fetch });
    const err = await client.whoami().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("UNAUTHORIZED");
    expect((err as ApiError).exitCode).toBe(CAPABILITY_EXIT.UNAUTHORIZED);
  });

  it("maps 403 to ApiError(FORBIDDEN)", async () => {
    const { fetch } = fakeFetch(new Response(null, { status: 403 }));
    const err = await createApiClient({ baseUrl: BASE, apiKey: KEY, fetch })
      .whoami()
      .catch((e) => e);
    expect((err as ApiError).code).toBe("FORBIDDEN");
  });

  it("treats an unmapped, non-retryable 5xx as UNEXPECTED in a single attempt", async () => {
    const { fetch, calls } = fakeFetch(new Response(null, { status: 500 }));
    const err = await createApiClient({ baseUrl: BASE, apiKey: KEY, fetch })
      .whoami()
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBeUndefined();
    expect((err as ApiError).exitCode).toBe(EXIT.UNEXPECTED);
    expect(calls).toHaveLength(1); // 500 is not transient → no retry
  });

  it("wraps a transport failure as an UNEXPECTED ApiError without leaking the cause", async () => {
    const fetch = (async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:443");
    }) as unknown as typeof fetch;
    const err = await createApiClient({ baseUrl: BASE, apiKey: KEY, fetch, sleep: async () => {} })
      .whoami()
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBeUndefined();
    expect((err as ApiError).userMessage).toContain(BASE);
    expect((err as ApiError).userMessage).not.toContain("ECONNREFUSED");
  });

  it("rejects a malformed identity response shape as UNEXPECTED", async () => {
    const { fetch } = fakeFetch(json({ notAnOrg: true }));
    const err = await createApiClient({ baseUrl: BASE, apiKey: KEY, fetch })
      .whoami()
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBeUndefined();
  });
});

describe("resolveApiBaseUrl", () => {
  it("prefers flag › env › stored › default", () => {
    expect(resolveApiBaseUrl({ flag: "https://f", env: "https://e", stored: "https://s" })).toBe(
      "https://f",
    );
    expect(resolveApiBaseUrl({ env: "https://e", stored: "https://s" })).toBe("https://e");
    expect(resolveApiBaseUrl({ stored: "https://s" })).toBe("https://s");
    expect(resolveApiBaseUrl({})).toBe(DEFAULT_API_BASE_URL);
  });

  it("re-validates a stored value (a tampered http:// stored base URL is rejected)", () => {
    expect(() => resolveApiBaseUrl({ stored: "http://evil.example" })).toThrow(InvalidApiUrlError);
    expect(resolveApiBaseUrl({ stored: "https://api.self-host.example/" })).toBe(
      "https://api.self-host.example",
    );
  });

  it("requires https for an override (rejecting http + non-URLs), and strips a trailing slash", () => {
    expect(() => resolveApiBaseUrl({ flag: "http://evil.example" })).toThrow(InvalidApiUrlError);
    expect(() => resolveApiBaseUrl({ env: "http://api.internal" })).toThrow(InvalidApiUrlError);
    expect(() => resolveApiBaseUrl({ flag: "not a url" })).toThrow(InvalidApiUrlError);
    expect(resolveApiBaseUrl({ flag: "https://api.example/" })).toBe("https://api.example");
  });

  it("rejects a base URL carrying a query or fragment (would mangle the request path)", () => {
    expect(() => resolveApiBaseUrl({ flag: "https://api.example?x=1" })).toThrow(
      InvalidApiUrlError,
    );
    expect(() => resolveApiBaseUrl({ flag: "https://api.example#frag" })).toThrow(
      InvalidApiUrlError,
    );
  });

  it("allows plaintext http ONLY for loopback dev hosts", () => {
    expect(resolveApiBaseUrl({ flag: "http://localhost:8787" })).toBe("http://localhost:8787");
    expect(resolveApiBaseUrl({ flag: "http://127.0.0.1:8787" })).toBe("http://127.0.0.1:8787");
  });
});

// Valid v4 UUIDs so the shared contract schemas (z.uuid()) accept the fixtures.
const EP_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const EV_ID = "33333333-3333-4333-8333-333333333333";

const endpoint = {
  id: EP_ID,
  orgId: ORG_ID,
  name: "orders-prod",
  paused: false,
  createdAt: "2026-05-01T00:00:00.000Z",
};
const eventSummary = {
  id: EV_ID,
  orgId: ORG_ID,
  endpointId: EP_ID,
  receivedAt: "2026-05-02T14:23:07.000Z",
  provider: "stripe",
  dedupKey: "dk_1",
  dedupStrategy: "sw_webhook_id",
  verified: true,
};
const fullEvent = {
  ...eventSummary,
  payloadR2Key: "r2/key",
  payloadBytes: 321,
  contentType: "application/json",
  headers: [["content-type", "application/json"]],
  providerEventId: null,
  externalId: null,
  verification: null,
};

describe("createApiClient read methods", () => {
  it("endpointsList GETs /v1/endpoints (no query when no params) and parses the page", async () => {
    const { fetch, calls } = fakeFetch(json({ items: [endpoint], nextCursor: null }));
    const page = await createApiClient({ baseUrl: BASE, apiKey: KEY, fetch }).endpointsList();
    expect(calls[0].url).toBe(`${BASE}/v1/endpoints`);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(page.nextCursor).toBeNull();
    expect(page.items[0].id).toBe(EP_ID);
    expect(page.items[0].createdAt).toBeInstanceOf(Date);
  });

  it("endpointsList encodes cursor + limit as query params", async () => {
    const { fetch, calls } = fakeFetch(json({ items: [], nextCursor: "next_c" }));
    await createApiClient({ baseUrl: BASE, apiKey: KEY, fetch }).endpointsList({
      cursor: "c1",
      limit: 25,
    });
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/v1/endpoints");
    expect(u.searchParams.get("cursor")).toBe("c1");
    expect(u.searchParams.get("limit")).toBe("25");
  });

  it("endpointsGet GETs /v1/endpoints/:id and parses the entity", async () => {
    const { fetch, calls } = fakeFetch(json(endpoint));
    const ep = await createApiClient({ baseUrl: BASE, apiKey: KEY, fetch }).endpointsGet(EP_ID);
    expect(calls[0].url).toBe(`${BASE}/v1/endpoints/${EP_ID}`);
    expect(ep.name).toBe("orders-prod");
    expect(ep.paused).toBe(false);
  });

  it("endpointsGet maps a 404 to ApiError(NOT_FOUND)", async () => {
    const { fetch } = fakeFetch(new Response(null, { status: 404 }));
    const err = await createApiClient({ baseUrl: BASE, apiKey: KEY, fetch })
      .endpointsGet(EP_ID)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("NOT_FOUND");
    expect((err as ApiError).exitCode).toBe(CAPABILITY_EXIT.NOT_FOUND);
  });

  it("eventsList encodes cursor + limit + provider and targets the nested path", async () => {
    const { fetch, calls } = fakeFetch(json({ items: [eventSummary], nextCursor: "ev_next" }));
    const page = await createApiClient({ baseUrl: BASE, apiKey: KEY, fetch }).eventsList(EP_ID, {
      cursor: "c2",
      limit: 5,
      provider: "stripe",
    });
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe(`/v1/endpoints/${EP_ID}/events`);
    expect(u.searchParams.get("cursor")).toBe("c2");
    expect(u.searchParams.get("limit")).toBe("5");
    expect(u.searchParams.get("provider")).toBe("stripe");
    expect(page.nextCursor).toBe("ev_next");
    expect(page.items[0].verified).toBe(true);
  });

  it("eventsGet GETs /v1/events/:id and parses the full event", async () => {
    const { fetch, calls } = fakeFetch(json(fullEvent));
    const ev = await createApiClient({ baseUrl: BASE, apiKey: KEY, fetch }).eventsGet(EV_ID);
    expect(calls[0].url).toBe(`${BASE}/v1/events/${EV_ID}`);
    expect(ev.payloadBytes).toBe(321);
    expect(ev.receivedAt).toBeInstanceOf(Date);
  });

  it("auditVerify POSTs /v1/audit/verify (bodyless) and parses the ok arm", async () => {
    const { fetch, calls } = fakeFetch(json({ ok: true, rowsVerified: 7 }));
    const result = await createApiClient({ baseUrl: BASE, apiKey: KEY, fetch }).auditVerify();
    expect(calls[0].url).toBe(`${BASE}/v1/audit/verify`);
    expect(calls[0].method).toBe("POST");
    expect(result).toEqual({ ok: true, rowsVerified: 7 });
  });

  it("auditVerify parses the break arm", async () => {
    const broken = {
      ok: false,
      rowsVerified: 2,
      break: { kind: "hash_mismatch", seq: 3, detail: "row 3 hash mismatch" },
    };
    const { fetch } = fakeFetch(json(broken));
    const result = await createApiClient({ baseUrl: BASE, apiKey: KEY, fetch }).auditVerify();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.break.kind).toBe("hash_mismatch");
  });

  it("rejects a malformed list response shape as UNEXPECTED (no capability code)", async () => {
    const { fetch } = fakeFetch(json({ items: "nope" }));
    const err = await createApiClient({ baseUrl: BASE, apiKey: KEY, fetch })
      .endpointsList()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBeUndefined();
  });

  it("eventsGetPayload GETs /v1/events/:id/payload and decodes the envelope to exact bytes", async () => {
    const body = new TextEncoder().encode('{"hello":"world"}');
    const { fetch, calls } = fakeFetch(
      json({
        contentType: "application/json",
        bytes: body.byteLength,
        bodyBase64: bytesToB64(body),
      }),
    );
    const res = await createApiClient({ baseUrl: BASE, apiKey: KEY, fetch }).eventsGetPayload(
      EV_ID,
    );
    expect(calls[0].url).toBe(`${BASE}/v1/events/${EV_ID}/payload`);
    expect(res.contentType).toBe("application/json");
    expect([...res.body]).toEqual([...body]);
  });

  it("eventsGetPayload maps a 404 to ApiError(NOT_FOUND)", async () => {
    const { fetch } = fakeFetch(new Response(null, { status: 404 }));
    const err = await createApiClient({ baseUrl: BASE, apiKey: KEY, fetch })
      .eventsGetPayload(EV_ID)
      .catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("NOT_FOUND");
  });

  it("eventsGetPayload rejects a corrupted envelope whose bytes disagree with the decoded length", async () => {
    const body = new TextEncoder().encode("abc");
    const { fetch } = fakeFetch(
      json({ contentType: null, bytes: 999, bodyBase64: bytesToB64(body) }),
    );
    const err = await createApiClient({ baseUrl: BASE, apiKey: KEY, fetch })
      .eventsGetPayload(EV_ID)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBeUndefined();
  });
});

// — bounded retries + per-request timeout (D1a) —

/** Returns each step in order (repeating the last); records whether the timeout signal had already fired. */
function sequenceFetch(steps: ReadonlyArray<Response | Error>): {
  fetch: typeof fetch;
  calls: { signalAborted: boolean }[];
} {
  const calls: { signalAborted: boolean }[] = [];
  let i = 0;
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({ signalAborted: init?.signal?.aborted ?? false });
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (step instanceof Error) throw step;
    return step;
  }) as unknown as typeof fetch;
  return { fetch, calls };
}

const instantSleep = async (_ms: number): Promise<void> => {};
const okIdentity = { orgId: "org_1", scopes: ["events:read"] };

describe("createApiClient retries + timeout", () => {
  it("retries a transient 503 then returns the success body", async () => {
    const { fetch, calls } = sequenceFetch([new Response(null, { status: 503 }), json(okIdentity)]);
    const client = createApiClient({ baseUrl: BASE, apiKey: KEY, fetch, sleep: instantSleep });
    expect(await client.whoami()).toEqual(okIdentity);
    expect(calls).toHaveLength(2);
  });

  it("waits the Retry-After (not a backoff) before retrying a 429", async () => {
    const slept: number[] = [];
    const { fetch } = sequenceFetch([
      new Response(null, { status: 429, headers: { "retry-after": "0" } }),
      json(okIdentity),
    ]);
    const client = createApiClient({
      baseUrl: BASE,
      apiKey: KEY,
      fetch,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await client.whoami();
    expect(slept).toEqual([0]);
  });

  it("retries a transport failure then succeeds", async () => {
    const { fetch, calls } = sequenceFetch([new Error("ECONNRESET"), json(okIdentity)]);
    const client = createApiClient({ baseUrl: BASE, apiKey: KEY, fetch, sleep: instantSleep });
    expect(await client.whoami()).toEqual(okIdentity);
    expect(calls).toHaveLength(2);
  });

  it("exhausts attempts on a persistent 503 and surfaces UNEXPECTED", async () => {
    const { fetch, calls } = sequenceFetch([new Response(null, { status: 503 })]);
    const client = createApiClient({ baseUrl: BASE, apiKey: KEY, fetch, sleep: instantSleep });
    const err = await client.whoami().catch((e: unknown) => e);
    expect((err as ApiError).exitCode).toBe(EXIT.UNEXPECTED);
    expect(calls).toHaveLength(3);
  });

  it("exhausts attempts on a persistent 429 and surfaces RATE_LIMITED", async () => {
    const { fetch, calls } = sequenceFetch([new Response(null, { status: 429 })]);
    const client = createApiClient({ baseUrl: BASE, apiKey: KEY, fetch, sleep: instantSleep });
    const err = await client.whoami().catch((e: unknown) => e);
    expect((err as ApiError).exitCode).toBe(CAPABILITY_EXIT.RATE_LIMITED);
    expect(calls).toHaveLength(3);
  });

  it("does not retry a terminal 404 (a single attempt)", async () => {
    const { fetch, calls } = sequenceFetch([new Response(null, { status: 404 })]);
    const client = createApiClient({ baseUrl: BASE, apiKey: KEY, fetch, sleep: instantSleep });
    const err = await client.endpointsGet("ep_x").catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("NOT_FOUND");
    expect(calls).toHaveLength(1);
  });

  it("retries an idempotent POST (auditVerify) on a transient 503", async () => {
    const { fetch, calls } = sequenceFetch([
      new Response(null, { status: 503 }),
      json({ ok: true, rowsVerified: 3 }),
    ]);
    const client = createApiClient({ baseUrl: BASE, apiKey: KEY, fetch, sleep: instantSleep });
    expect(await client.auditVerify()).toMatchObject({ ok: true, rowsVerified: 3 });
    expect(calls).toHaveLength(2);
  });

  it("treats a timed-out (aborted) request as a retryable transport failure and recovers", async () => {
    let n = 0;
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      n += 1;
      if (init?.signal?.aborted) throw new DOMException("the operation timed out", "TimeoutError");
      return json(okIdentity);
    }) as unknown as typeof fetch;
    const signals = [AbortSignal.abort(), new AbortController().signal];
    let s = 0;
    const client = createApiClient({
      baseUrl: BASE,
      apiKey: KEY,
      fetch,
      sleep: instantSleep,
      timeoutSignal: () => signals[s++],
    });
    expect(await client.whoami()).toEqual(okIdentity);
    expect(n).toBe(2);
  });
});
