import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { uploadAvatarWebp } from "./avatar-upload";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", (...a: unknown[]) => fetchMock(...a));
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const webp = () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" });

describe("uploadAvatarWebp", () => {
  it("POSTs the webp bytes to the upload route as image/webp, same-origin", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const res = await uploadAvatarWebp(webp());

    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/avatar/upload");
    expect(init.method).toBe("POST");
    // Cookies must ride along — the route gates on the session.
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).get("content-type")).toBe("image/webp");
    expect(init.body).toBeInstanceOf(Blob);
  });

  it("maps 413 to a size message and never claims success", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 413 }));
    const res = await uploadAvatarWebp(webp());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/too large/i);
  });

  it("maps 415 to an unsupported-image message", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 415 }));
    const res = await uploadAvatarWebp(webp());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/image/i);
  });

  it("maps 403 to a session message (the CSRF/expired case)", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    const res = await uploadAvatarWebp(webp());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/session|sign|refresh/i);
  });

  it("maps 503 to a temporarily-unavailable message", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    const res = await uploadAvatarWebp(webp());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unavailable|temporar/i);
  });

  it("treats a thrown fetch (offline) as a friendly failure, not a crash", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const res = await uploadAvatarWebp(webp());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/try again|connection|network/i);
  });

  it("forwards an abort signal so a slow upload can be cancelled", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const ctrl = new AbortController();
    await uploadAvatarWebp(webp(), { signal: ctrl.signal });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(ctrl.signal);
  });
});
