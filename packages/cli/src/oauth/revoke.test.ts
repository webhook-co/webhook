import { describe, expect, it } from "vitest";

import { revokeToken } from "./revoke.js";

/** A fetch that records the request + returns a fixed response. */
function recordingFetch(res: Response): {
  fetch: typeof fetch;
  calls: () => number;
  body: () => URLSearchParams;
  url: () => string;
  contentType: () => string | undefined;
} {
  let count = 0;
  let captured: { url: string; body: string; contentType?: string } = { url: "", body: "" };
  const f = (async (url: string, init?: RequestInit) => {
    count += 1;
    const headers = new Headers(init?.headers);
    captured = {
      url,
      body: String(init?.body),
      contentType: headers.get("content-type") ?? undefined,
    };
    return res;
  }) as unknown as typeof fetch;
  return {
    fetch: f,
    calls: () => count,
    body: () => new URLSearchParams(captured.body),
    url: () => captured.url,
    contentType: () => captured.contentType,
  };
}

describe("revokeToken", () => {
  it("POSTs the token as a form field (RFC 7009)", async () => {
    const rec = recordingFetch(new Response(null, { status: 200 }));
    await revokeToken({ fetch: rec.fetch }, "https://auth.webhook.co/revoke", "rtk_refresh");
    expect(rec.url()).toBe("https://auth.webhook.co/revoke");
    expect(rec.contentType()).toBe("application/x-www-form-urlencoded");
    expect(rec.body().get("token")).toBe("rtk_refresh");
  });

  it("is best-effort: resolves even when the server returns a non-2xx status", async () => {
    const rec = recordingFetch(new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    await expect(
      revokeToken({ fetch: rec.fetch }, "https://auth.webhook.co/revoke", "rtk_refresh"),
    ).resolves.toBeUndefined();
    expect(rec.calls()).toBe(1);
  });

  it("propagates a transport failure to the caller", async () => {
    const f = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(
      revokeToken({ fetch: f }, "https://auth.webhook.co/revoke", "rtk_refresh"),
    ).rejects.toThrow("network down");
  });
});
