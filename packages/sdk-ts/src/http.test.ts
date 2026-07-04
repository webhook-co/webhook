import { describe, expect, it } from "vitest";

import {
  WebhookAuthenticationError,
  WebhookConnectionError,
  WebhookNotFoundError,
  WebhookPermissionError,
  WebhookRateLimitError,
  WebhookTargetUnreachableError,
  WebhookUnexpectedResponseError,
} from "./errors.js";
import { createHttpClient, type HttpClientConfig } from "./http.js";

const API_KEY = "whk_test_key_abcdefghijklmnop";
const BASE = "https://api.webhook.co";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
function textResponse(
  status: number,
  text: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain", ...headers } });
}
function emptyResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

/** A fetch stub that dispenses queued responses (or throws a queued Error) and records each call. */
function fakeFetch(queue: Array<Response | Error>): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    const next = queue[calls.length - 1];
    if (next === undefined) throw new Error("fakeFetch: unexpected extra call");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

function makeClient(
  queue: Array<Response | Error>,
  overrides: Partial<HttpClientConfig> = {},
): {
  client: ReturnType<typeof createHttpClient>;
  calls: Array<{ url: string; init: RequestInit }>;
  sleeps: number[];
} {
  const { fetch: fetchFn, calls } = fakeFetch(queue);
  const sleeps: number[] = [];
  const client = createHttpClient({
    baseUrl: BASE,
    apiKey: API_KEY,
    fetch: fetchFn,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    rand: () => 0,
    timeoutSignal: () => new AbortController().signal,
    ...overrides,
  });
  return { client, calls, sleeps };
}

function authHeader(init: RequestInit): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.["authorization"];
}

describe("createHttpClient.request", () => {
  it("sends a bearer GET and returns the parsed JSON body", async () => {
    const { client, calls } = makeClient([jsonResponse(200, { ok: true })]);
    const body = await client.request({ method: "GET", path: "/v1/whoami", idempotent: true });
    expect(body).toEqual({ ok: true });
    expect(calls[0]!.url).toBe(`${BASE}/v1/whoami`);
    expect(calls[0]!.init.method).toBe("GET");
    expect(authHeader(calls[0]!.init)).toBe(`Bearer ${API_KEY}`);
    expect((calls[0]!.init.headers as Record<string, string>)["accept"]).toBe("application/json");
  });

  it("serialises a JSON body and sets content-type on a POST", async () => {
    const { client, calls } = makeClient([jsonResponse(200, { id: "e1" })]);
    await client.request({
      method: "POST",
      path: "/v1/endpoints",
      body: { name: "x" },
      idempotent: false,
    });
    expect(calls[0]!.init.body).toBe(JSON.stringify({ name: "x" }));
    expect((calls[0]!.init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
  });

  it("sends no body or content-type when the body is undefined", async () => {
    const { client, calls } = makeClient([jsonResponse(200, {})]);
    await client.request({ method: "POST", path: "/v1/audit/verify", idempotent: true });
    expect(calls[0]!.init.body).toBeUndefined();
    expect((calls[0]!.init.headers as Record<string, string>)["content-type"]).toBeUndefined();
  });

  it("retries an idempotent GET on a transient 502 then succeeds", async () => {
    const { client, calls, sleeps } = makeClient([
      jsonResponse(502, { error: "TARGET_UNREACHABLE", message: "bad gateway" }),
      jsonResponse(200, { ok: 1 }),
    ]);
    const body = await client.request({ method: "GET", path: "/v1/endpoints", idempotent: true });
    expect(body).toEqual({ ok: 1 });
    expect(calls).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
  });

  it("does NOT retry a non-idempotent POST on a 502 (throws immediately)", async () => {
    const { client, calls } = makeClient([
      jsonResponse(502, { error: "TARGET_UNREACHABLE", message: "bad gateway" }),
    ]);
    await expect(
      client.request({ method: "POST", path: "/v1/endpoints", body: {}, idempotent: false }),
    ).rejects.toBeInstanceOf(WebhookTargetUnreachableError);
    expect(calls).toHaveLength(1);
  });

  it("retries an idempotent request on a transport failure then succeeds", async () => {
    const { client, calls } = makeClient([
      new TypeError("network down"),
      jsonResponse(200, { ok: 1 }),
    ]);
    const body = await client.request({ method: "GET", path: "/v1/endpoints", idempotent: true });
    expect(body).toEqual({ ok: 1 });
    expect(calls).toHaveLength(2);
  });

  it("surfaces a connection error for a non-idempotent transport failure", async () => {
    const { client, calls } = makeClient([new TypeError("network down")]);
    await expect(
      client.request({ method: "POST", path: "/v1/endpoints", body: {}, idempotent: false }),
    ).rejects.toBeInstanceOf(WebhookConnectionError);
    expect(calls).toHaveLength(1);
  });

  it("honours a Retry-After header on a 429 for the backoff delay", async () => {
    const { client, sleeps } = makeClient([
      jsonResponse(429, { error: "RATE_LIMITED", message: "slow down" }, { "retry-after": "7" }),
      jsonResponse(200, { ok: 1 }),
    ]);
    await client.request({ method: "GET", path: "/v1/endpoints", idempotent: true });
    expect(sleeps).toEqual([7000]);
  });

  it("gives up after maxRetries and throws the typed error", async () => {
    const { client, calls } = makeClient(
      [
        jsonResponse(429, { error: "RATE_LIMITED", message: "slow" }),
        jsonResponse(429, { error: "RATE_LIMITED", message: "slow" }),
        jsonResponse(429, { error: "RATE_LIMITED", message: "slow" }),
      ],
      { maxRetries: 2 },
    );
    await expect(
      client.request({ method: "GET", path: "/v1/endpoints", idempotent: true }),
    ).rejects.toBeInstanceOf(WebhookRateLimitError);
    expect(calls).toHaveLength(3);
  });

  it("refreshes the bearer once on a 401 and retries with the new token", async () => {
    const { client, calls } = makeClient([emptyResponse(401), jsonResponse(200, { ok: 1 })], {
      refreshAuth: async () => "whk_rotated_new_token_value",
    });
    const body = await client.request({ method: "GET", path: "/v1/whoami", idempotent: true });
    expect(body).toEqual({ ok: 1 });
    expect(authHeader(calls[0]!.init)).toBe(`Bearer ${API_KEY}`);
    expect(authHeader(calls[1]!.init)).toBe("Bearer whk_rotated_new_token_value");
  });

  it("surfaces a 401 when the refresh hook declines (returns null)", async () => {
    const { client, calls } = makeClient([emptyResponse(401)], { refreshAuth: async () => null });
    await expect(
      client.request({ method: "GET", path: "/v1/whoami", idempotent: true }),
    ).rejects.toBeInstanceOf(WebhookAuthenticationError);
    expect(calls).toHaveLength(1);
  });

  it("surfaces a 401 immediately when there is no refresh hook", async () => {
    const { client, calls } = makeClient([emptyResponse(401)]);
    await expect(
      client.request({ method: "GET", path: "/v1/whoami", idempotent: true }),
    ).rejects.toBeInstanceOf(WebhookAuthenticationError);
    expect(calls).toHaveLength(1);
  });

  it("maps an empty-body 403 to a permission error with the default message", async () => {
    const { client } = makeClient([emptyResponse(403)]);
    const err = await client
      .request({ method: "GET", path: "/v1/endpoints", idempotent: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebhookPermissionError);
    expect((err as WebhookPermissionError).message).toContain("scope");
  });

  it("maps a text/plain 404 (router miss) to a not-found error", async () => {
    const { client } = makeClient([textResponse(404, "Not Found")]);
    await expect(
      client.request({ method: "GET", path: "/v1/nope", idempotent: true }),
    ).rejects.toBeInstanceOf(WebhookNotFoundError);
  });

  it("throws an unexpected-response error for malformed JSON on a 200", async () => {
    const bad = new Response("{not json", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const { client } = makeClient([bad]);
    await expect(
      client.request({ method: "GET", path: "/v1/endpoints", idempotent: true }),
    ).rejects.toBeInstanceOf(WebhookUnexpectedResponseError);
  });

  it("threads the server request id into the error", async () => {
    const { client } = makeClient([
      jsonResponse(404, { error: "NOT_FOUND", message: "gone" }, { "x-request-id": "req_123" }),
    ]);
    const err = await client
      .request({ method: "GET", path: "/v1/endpoints/x", idempotent: true })
      .catch((e: unknown) => e);
    expect((err as WebhookNotFoundError).requestId).toBe("req_123");
  });

  it("carries retryAfterMs on a non-retried 429 (non-idempotent)", async () => {
    const { client } = makeClient([
      jsonResponse(429, { error: "RATE_LIMITED", message: "slow" }, { "retry-after": "12" }),
    ]);
    const err = await client
      .request({ method: "POST", path: "/v1/subscriptions", body: {}, idempotent: false })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebhookRateLimitError);
    expect((err as WebhookRateLimitError).retryAfterMs).toBe(12000);
  });

  it("redacts the API key if it ever appears in a server error message", async () => {
    const { client } = makeClient([
      jsonResponse(400, { error: "VALIDATION_ERROR", message: `bad token ${API_KEY} sent` }),
    ]);
    const err = await client
      .request({ method: "GET", path: "/v1/endpoints", idempotent: true })
      .catch((e: unknown) => e);
    expect((err as Error).message).not.toContain(API_KEY);
    expect((err as Error).message).toContain("[redacted]");
  });

  it("invokes an onRequest debug hook without leaking the key", async () => {
    const seen: string[] = [];
    const { client } = makeClient([jsonResponse(200, { ok: 1 })], {
      onDebug: (line: string) => seen.push(line),
    });
    await client.request({ method: "GET", path: "/v1/whoami", idempotent: true });
    expect(seen.length).toBeGreaterThan(0);
    for (const line of seen) expect(line).not.toContain(API_KEY);
  });

  it("sets redirect:error so a hostile 3xx can't leak the Authorization header", async () => {
    const { client, calls } = makeClient([jsonResponse(200, { ok: 1 })]);
    await client.request({ method: "GET", path: "/v1/whoami", idempotent: true });
    expect(calls[0]!.init.redirect).toBe("error");
  });

  it("redacts a rotated bearer (from refreshAuth) that later appears in an error message", async () => {
    const ROTATED = "rotated-opaque-secret-not-whk-prefixed-123456";
    const debugLines: string[] = [];
    const { client } = makeClient(
      [
        emptyResponse(401),
        jsonResponse(400, { error: "VALIDATION_ERROR", message: `bad token ${ROTATED} sent` }),
      ],
      { refreshAuth: async () => ROTATED, onDebug: (line: string) => debugLines.push(line) },
    );
    const err = await client
      .request({ method: "GET", path: "/v1/whoami", idempotent: true })
      .catch((e: unknown) => e);
    expect((err as Error).message).not.toContain(ROTATED);
    expect((err as Error).message).toContain("[redacted]");
    for (const line of debugLines) expect(line).not.toContain(ROTATED);
  });
});
