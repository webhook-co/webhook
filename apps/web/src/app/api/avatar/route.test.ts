import { beforeEach, describe, expect, it, vi } from "vitest";

const verifySession = vi.fn();
vi.mock("@/server/session", () => ({ verifySession: () => verifySession() }));

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
});

describe("GET /api/avatar", () => {
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

  it("marks the response private — it is one specific person's face", async () => {
    fetchMock.mockResolvedValue(png());

    const res = await GET();

    // A shared/proxy cache must never hand this to the next person through.
    expect(res.headers.get("cache-control")).toContain("private");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
