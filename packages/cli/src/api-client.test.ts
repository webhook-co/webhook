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

/** A fake fetch returning a fixed Response; records the URL + headers it was called with. */
function fakeFetch(res: Response): {
  fetch: typeof fetch;
  calls: { url: string; headers: Headers }[];
} {
  const calls: { url: string; headers: Headers }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
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

  it("treats an unmapped 5xx as an UNEXPECTED ApiError (no capability code)", async () => {
    const { fetch } = fakeFetch(new Response(null, { status: 503 }));
    const err = await createApiClient({ baseUrl: BASE, apiKey: KEY, fetch })
      .whoami()
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBeUndefined();
    expect((err as ApiError).exitCode).toBe(EXIT.UNEXPECTED);
  });

  it("wraps a transport failure as an UNEXPECTED ApiError without leaking the cause", async () => {
    const fetch = (async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:443");
    }) as unknown as typeof fetch;
    const err = await createApiClient({ baseUrl: BASE, apiKey: KEY, fetch })
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
  it("prefers flag › env › default", () => {
    expect(resolveApiBaseUrl({ flag: "https://f", env: "https://e" })).toBe("https://f");
    expect(resolveApiBaseUrl({ env: "https://e" })).toBe("https://e");
    expect(resolveApiBaseUrl({})).toBe(DEFAULT_API_BASE_URL);
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
