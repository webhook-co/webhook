import { describe, expect, it, vi } from "vitest";

import { sendMagicLinkEmail } from "./magic-link";

// A1b-1 — the magic-link email sender (pure, injected fetch). Better Auth's magicLink plugin calls this
// from its sendMagicLink callback. We send via the Resend REST API (no SDK) from the verified sender
// mail.webhook.co; tracking is off at the Resend domain level (scanners pre-fetch tracked links and burn
// the single-use token), so the send carries no tracking flags. The api key must never leak into an error.

const FROM = "login@mail.webhook.co";
const LINK = "https://auth.webhook.co/api/auth/magic-link/verify?token=tok_abc123";

function okFetch() {
  return vi.fn(async () => new Response(JSON.stringify({ id: "email_1" }), { status: 200 }));
}

describe("sendMagicLinkEmail", () => {
  it("POSTs the link to the Resend API with bearer auth + the configured sender", async () => {
    const fetchImpl = okFetch();
    await sendMagicLinkEmail(
      { apiKey: "re_test_key", from: FROM, fetchImpl },
      { to: "user@example.com", url: LINK },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test_key");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body as string);
    expect(body.from).toBe(FROM);
    expect(body.to).toBe("user@example.com");
  });

  it("includes the magic-link URL in both an html and a text part", async () => {
    const fetchImpl = okFetch();
    await sendMagicLinkEmail({ apiKey: "k", from: FROM, fetchImpl }, { to: "u@e.com", url: LINK });

    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.html).toContain(LINK);
    expect(body.text).toContain(LINK);
    expect(typeof body.subject).toBe("string");
    expect(body.subject.length).toBeGreaterThan(0);
  });

  it("carries no click/open tracking flags (single-use link must not be pre-fetched)", async () => {
    const fetchImpl = okFetch();
    await sendMagicLinkEmail({ apiKey: "k", from: FROM, fetchImpl }, { to: "u@e.com", url: LINK });
    const raw = (fetchImpl.mock.calls[0][1] as RequestInit).body as string;
    // Defensive: the body must not enable any tracking even if Resend's account default changes.
    expect(raw.toLowerCase()).not.toContain("tracking");
  });

  it("throws on a non-2xx Resend response WITHOUT leaking the api key", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad request", { status: 422 }));
    const call = () =>
      sendMagicLinkEmail(
        { apiKey: "re_super_secret", from: FROM, fetchImpl },
        { to: "u@e.com", url: LINK },
      );
    await expect(call()).rejects.toThrow();
    await call().catch((e: unknown) => {
      expect(String(e)).not.toContain("re_super_secret");
    });
  });
});
