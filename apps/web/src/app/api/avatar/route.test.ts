import { beforeEach, describe, expect, it, vi } from "vitest";

const verifySession = vi.fn();
vi.mock("@/server/session", () => ({ verifySession: () => verifySession() }));

// Default: no R2 binding → the route falls through to the provider proxy (the existing behavior).
const getAvatarBucket = vi.fn(async (): Promise<unknown> => undefined);
vi.mock("@/server/avatar-r2", () => ({ getAvatarBucket: () => getAvatarBucket() }));

import { GET } from "./route";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", (...args: unknown[]) => fetchMock(...args));

const SESSION = (over: Partial<{ image: string | null; email: string }> = {}) => ({
  userId: "usr_1",
  orgId: "org_1",
  user: { name: "Dana", email: "dana@acme.co", image: null, ...over },
});

const png = (body = "bytes") =>
  new Response(body, { status: 200, headers: { "content-type": "image/png" } });

beforeEach(() => {
  vi.clearAllMocks();
  verifySession.mockResolvedValue(SESSION());
  getAvatarBucket.mockResolvedValue(undefined);
});

describe("GET /api/avatar", () => {
  it("serves the UPLOADED avatar from R2 (forced image/webp) and never proxies", async () => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    const get = vi.fn(async (key: string) =>
      key === "user/usr_1/avatar.webp" ? { arrayBuffer: async () => buf } : null,
    );
    getAvatarBucket.mockResolvedValue({ get, put: vi.fn(), delete: vi.fn() });

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=60");
    expect(fetchMock).not.toHaveBeenCalled(); // R2 hit wins — no provider proxy
  });

  it("falls back to the provider proxy when R2 has no uploaded avatar", async () => {
    const get = vi.fn(async () => null); // R2 miss
    getAvatarBucket.mockResolvedValue({ get, put: vi.fn(), delete: vi.fn() });
    verifySession.mockResolvedValue(
      SESSION({ image: "https://avatars.githubusercontent.com/u/1" }),
    );
    fetchMock.mockResolvedValue(png());

    await GET();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("is gated — it resolves the session before it does anything else", async () => {
    verifySession.mockRejectedValueOnce(new Error("redirect to login"));
    await expect(GET()).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves the provider's avatar when the session carries one we trust", async () => {
    verifySession.mockResolvedValue(
      SESSION({ image: "https://avatars.githubusercontent.com/u/1" }),
    );
    fetchMock.mockResolvedValue(png());

    const res = await GET();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("https://avatars.githubusercontent.com/u/1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  // THE SSRF CASE. If the stored image ever became attacker-controlled — a compromised provider, a bug in
  // another app writing that column — this must not become a fetch to it.
  it("NEVER fetches a URL outside the allowlist, even one handed to it in the session", async () => {
    verifySession.mockResolvedValue(SESSION({ image: "http://169.254.169.254/latest/meta-data/" }));
    fetchMock.mockResolvedValue(png());

    await GET();

    // It fell through to Gravatar — whose host is a constant — rather than fetching the metadata endpoint.
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new URL(fetchMock.mock.calls[0][0] as string).hostname).toBe("gravatar.com");
  });

  it("does not follow redirects off the allowlisted host", async () => {
    verifySession.mockResolvedValue(SESSION({ image: "https://lh3.googleusercontent.com/a/x" }));
    fetchMock.mockResolvedValue(png());

    await GET();

    // An open redirect on a provider CDN would otherwise walk straight through the allowlist.
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  // A 404 from Gravatar is the EXPECTED answer for most users (`d=404`), not an error.
  //
  // And we answer 404 too — NOT 204. A `<img>` that receives a 204 does not reliably fire `error` in Chrome:
  // it renders the broken-image glyph, and the component's initials fallback never runs. I shipped 204 first
  // and the account page showed a torn-picture icon on top of the initials. jsdom does not load images, so no
  // test could see it — only opening the page could. This assertion is what stops it coming back.
  it("answers 404 — NOT 204 — when the user has no avatar, so the <img> fallback actually fires", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

    const res = await GET();

    expect(res.status).toBe(404);
    // Still cached: without it, every page view re-asks Gravatar about a user who will never have one.
    expect(res.headers.get("cache-control")).toContain("private");
  });

  it("answers 404 rather than failing the page when the upstream is down", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));

    const res = await GET();

    expect(res.status).toBe(404);
  });

  // An upstream that answers `image/svg+xml` would be handing us ACTIVE CONTENT on our OWN ORIGIN — SVG
  // carries script, and this response is same-origin. Refuse it; do not sniff it.
  it("refuses to serve SVG or HTML, whatever the upstream claims", async () => {
    for (const type of ["image/svg+xml", "text/html", "application/javascript"]) {
      fetchMock.mockResolvedValue(
        new Response("<svg onload=alert(1)>", { status: 200, headers: { "content-type": type } }),
      );
      const res = await GET();
      expect(res.status).toBe(404);
    }
  });

  // The URL is a CONSTANT (`/api/avatar`, no parameters) and the response is one specific person's face,
  // resolved from their cookie. That is precisely the shape a shared cache gets wrong: same key, different
  // answers, and the difference lives in a header. Serving one customer's photograph to another is not a
  // mistake you get to make twice.
  it("cannot be cached across users — private, and Vary on the cookie that distinguishes them", async () => {
    fetchMock.mockResolvedValue(png());

    const res = await GET();

    // The instruction: browser only, never a shared cache.
    expect(res.headers.get("cache-control")).toContain("private");
    // The belt to its braces: a cache that DOES store this is told the response is a function of the cookie,
    // so two users cannot collide on the key even if `private` were ignored.
    expect(res.headers.get("vary")).toBe("Cookie");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("varies on the cookie for the no-avatar answer too", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

    const res = await GET();

    expect(res.headers.get("vary")).toBe("Cookie");
  });
});
