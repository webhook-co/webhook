import { describe, expect, it, vi } from "vitest";

import { sendEmailChangedNotice, sendEmailChangeOtp } from "./email-change-email";

// The email-change ceremony's two senders (pure, injected fetch): the step-up OTP to the address on record,
// and the after-the-fact notice to the OLD address. Both send via the Resend REST API from the verified
// notifications sender. Tracking stays off at the Resend domain level, so neither body carries a tracking
// flag, and the api key must never reach an error message.

function okFetch() {
  return vi.fn(async () => new Response(JSON.stringify({ id: "email_1" }), { status: 200 }));
}

function bodyOf(fetchImpl: ReturnType<typeof okFetch>) {
  return JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
}

describe("sendEmailChangeOtp", () => {
  it("POSTs to Resend with bearer auth, the recipient and the notifications sender", async () => {
    const fetchImpl = okFetch();
    await sendEmailChangeOtp({ apiKey: "k", fetchImpl }, { to: "u@e.com", code: "418290" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    const body = bodyOf(fetchImpl);
    expect(body.to).toBe("u@e.com");
    expect(body.from).toContain("notifications@mail.webhook.co");
    expect(body.subject).toBe("Your webhook.co verification code");
  });

  it("renders the code in both the html and the text part", async () => {
    const fetchImpl = okFetch();
    await sendEmailChangeOtp({ apiKey: "k", fetchImpl }, { to: "u@e.com", code: "418290" });
    const body = bodyOf(fetchImpl);
    expect(body.html).toContain("418290");
    expect(body.text).toContain("418290");
  });

  it("renders the branded shell — logo, text wordmark, and the code as the hero", async () => {
    const fetchImpl = okFetch();
    await sendEmailChangeOtp({ apiKey: "k", fetchImpl }, { to: "u@e.com", code: "418290" });
    const { html } = bodyOf(fetchImpl);
    expect(html).toContain('src="https://www.webhook.co/logo.png"');
    expect(html).toContain(">webhook</span>");
    expect(html).toContain("letter-spacing:6px");
  });

  it("offers no button — a code is typed back, never clicked", async () => {
    const fetchImpl = okFetch();
    await sendEmailChangeOtp({ apiKey: "k", fetchImpl }, { to: "u@e.com", code: "418290" });
    const { html } = bodyOf(fetchImpl);
    expect(html).not.toContain("<a href=");
  });

  it("carries no tracking flags — a scanner must not pre-fetch its way to the code", async () => {
    const fetchImpl = okFetch();
    await sendEmailChangeOtp({ apiKey: "k", fetchImpl }, { to: "u@e.com", code: "418290" });
    const raw = (fetchImpl.mock.calls[0][1] as RequestInit).body as string;
    expect(raw.toLowerCase()).not.toContain("tracking");
  });

  it("throws on a non-2xx WITHOUT leaking the api key", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 422 }));
    const call = () =>
      sendEmailChangeOtp({ apiKey: "re_super_secret", fetchImpl }, { to: "u@e.com", code: "1" });
    await expect(call()).rejects.toThrow(/422/);
    await expect(call()).rejects.not.toThrow(/re_super_secret/);
  });
});

describe("sendEmailChangedNotice", () => {
  it("POSTs to Resend addressed to the OLD address, naming the new one", async () => {
    const fetchImpl = okFetch();
    await sendEmailChangedNotice(
      { apiKey: "k", fetchImpl },
      { to: "old@e.com", newEmail: "new@e.com" },
    );

    const body = bodyOf(fetchImpl);
    expect(body.to).toBe("old@e.com");
    expect(body.subject).toBe("Your webhook.co email was changed");
    expect(body.html).toContain("new@e.com");
    expect(body.text).toContain("new@e.com");
  });

  it("renders the branded shell", async () => {
    const fetchImpl = okFetch();
    await sendEmailChangedNotice(
      { apiKey: "k", fetchImpl },
      { to: "old@e.com", newEmail: "new@e.com" },
    );
    const { html } = bodyOf(fetchImpl);
    expect(html).toContain('src="https://www.webhook.co/logo.png"');
    expect(html).toContain(">webhook</span>");
  });

  // The new address is attacker-controlled in exactly the scenario this email exists to expose: a hijacker
  // who changed it. It must never carry markup into the message warning the victim about them.
  it("ESCAPES the new email into the HTML", async () => {
    const fetchImpl = okFetch();
    await sendEmailChangedNotice(
      { apiKey: "k", fetchImpl },
      { to: "old@e.com", newEmail: '<img src=x onerror="alert(1)">@e.com' },
    );
    const { html } = bodyOf(fetchImpl);
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).toContain("&lt;img src=x onerror=");
  });

  it("throws on a non-2xx WITHOUT leaking the api key", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const call = () =>
      sendEmailChangedNotice(
        { apiKey: "re_super_secret", fetchImpl },
        { to: "old@e.com", newEmail: "new@e.com" },
      );
    await expect(call()).rejects.toThrow(/500/);
    await expect(call()).rejects.not.toThrow(/re_super_secret/);
  });
});
