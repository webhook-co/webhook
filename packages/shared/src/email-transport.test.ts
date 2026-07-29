import { describe, expect, it, vi } from "vitest";

import { deliverEmail, resolveEmailMode, type EmailTransport } from "./email-transport";

// A Secrets Store binding, structurally: an object with `.get()`. This is the PROD shape — the deploy
// overlay emits `secrets_store_secrets`, dev/test pass plain strings. The fence keys on exactly this.
const storeBinding = { get: async () => "re_live_realkey" };

const EMAIL = {
  to: "dev@example.com",
  subject: "Your webhook.co sign-in link",
  html: "<p>hi</p>",
  text: "hi",
  kind: "magic-link",
  link: "http://localhost:8788/api/auth/magic-link/verify?token=abc123",
} as const;

// Distinctive enough that a substring assertion cannot pass by accident — the failure mode this guards is a
// key leaking into a log line or an error message.
const API_KEY = "re_ZZTOPSECRETZZ_must_never_be_printed";

function sendTransport(over: Partial<EmailTransport> = {}): EmailTransport {
  return { mode: "send", apiKey: API_KEY, from: "login@mail.webhook.co", ...over };
}

describe("resolveEmailMode", () => {
  it("defaults to send when EMAIL_MODE is unset — prod sets nothing and must send", () => {
    expect(resolveEmailMode({})).toBe("send");
  });

  it("accepts an explicit send", () => {
    expect(resolveEmailMode({ EMAIL_MODE: "send" })).toBe("send");
  });

  it("returns log when EMAIL_MODE=log and the key is a plain string (the dev shape)", () => {
    expect(resolveEmailMode({ EMAIL_MODE: "log", RESEND_API_KEY: "re_dev" })).toBe("log");
  });

  it("returns log when EMAIL_MODE=log and no Resend key is bound at all", () => {
    expect(resolveEmailMode({ EMAIL_MODE: "log" })).toBe("log");
  });

  // THE fence. Log mode in production would print single-use sign-in links into log storage AND stop
  // every transactional email. A Secrets Store binding is the shape only the deploy overlay produces.
  it("REFUSES log mode when RESEND_API_KEY is a Secrets Store binding (the prod shape)", () => {
    expect(() => resolveEmailMode({ EMAIL_MODE: "log", RESEND_API_KEY: storeBinding })).toThrow(
      /refusing EMAIL_MODE=log/,
    );
  });

  it("names the binding it refused on, so the misconfig is actionable", () => {
    expect(() => resolveEmailMode({ EMAIL_MODE: "log", RESEND_API_KEY: storeBinding })).toThrow(
      /RESEND_API_KEY/,
    );
  });

  it("throws on an unknown mode rather than guessing", () => {
    expect(() => resolveEmailMode({ EMAIL_MODE: "lo" })).toThrow(/EMAIL_MODE/);
  });

  it("is case-sensitive — LOG is a typo, not a mode, and must not silently send", () => {
    expect(() => resolveEmailMode({ EMAIL_MODE: "LOG" })).toThrow(/EMAIL_MODE/);
  });
});

describe("deliverEmail — send mode", () => {
  it("POSTs to Resend with the bearer key and the rendered body", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await deliverEmail(sendTransport({ fetchImpl: fetchImpl as unknown as typeof fetch }), EMAIL);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(init.body as string)).toEqual({
      from: "login@mail.webhook.co",
      to: EMAIL.to,
      subject: EMAIL.subject,
      html: EMAIL.html,
      text: EMAIL.text,
    });
  });

  // The notification drain sends `to: [address]`; the other three send a bare string. Both must reach the
  // wire untouched — normalising would silently change what four senders send.
  it("passes an array recipient through verbatim", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await deliverEmail(sendTransport({ fetchImpl: fetchImpl as unknown as typeof fetch }), {
      ...EMAIL,
      to: ["ops@example.com"],
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).to).toEqual(["ops@example.com"]);
  });

  it("passes a string recipient through verbatim", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await deliverEmail(sendTransport({ fetchImpl: fetchImpl as unknown as typeof fetch }), EMAIL);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).to).toBe(EMAIL.to);
  });

  it("throws with the kind and the status on a non-2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 422 }));
    await expect(
      deliverEmail(sendTransport({ fetchImpl: fetchImpl as unknown as typeof fetch }), EMAIL),
    ).rejects.toThrow("magic-link email send failed with status 422");
  });

  it("never puts the API key in the failure message", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
    const err = await deliverEmail(
      sendTransport({ fetchImpl: fetchImpl as unknown as typeof fetch }),
      EMAIL,
    ).catch((e: unknown) => e);
    expect(String(err)).not.toContain(API_KEY);
  });
});

describe("deliverEmail — log mode", () => {
  it("makes NO network call — hermetic means hermetic", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const lines: string[] = [];
    await deliverEmail(
      {
        mode: "log",
        apiKey: "",
        from: "login@mail.webhook.co",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        logImpl: (l) => lines.push(l),
      },
      EMAIL,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("prints the link — the whole point is that a developer can click it", async () => {
    const lines: string[] = [];
    await deliverEmail(
      { mode: "log", apiKey: "", from: "x@y.z", logImpl: (l) => lines.push(l) },
      EMAIL,
    );
    expect(lines.join("\n")).toContain(EMAIL.link);
  });

  it("identifies the kind and the recipient", async () => {
    const lines: string[] = [];
    await deliverEmail(
      { mode: "log", apiKey: "", from: "x@y.z", logImpl: (l) => lines.push(l) },
      EMAIL,
    );
    const out = lines.join("\n");
    expect(out).toContain("magic-link");
    expect(out).toContain(EMAIL.to);
  });

  it("says so plainly when an email carries no link (an OTP has nothing to click)", async () => {
    const lines: string[] = [];
    await deliverEmail({ mode: "log", apiKey: "", from: "x@y.z", logImpl: (l) => lines.push(l) }, {
      ...EMAIL,
      kind: "email-change",
      link: undefined,
    } as typeof EMAIL);
    const out = lines.join("\n");
    expect(out).toContain("email-change");
    // The text body carries the OTP code, so it must be reachable in log mode.
    expect(out).toContain(EMAIL.text);
  });

  it("never prints the API key, even when one is configured", async () => {
    const lines: string[] = [];
    await deliverEmail(
      { mode: "log", apiKey: API_KEY, from: "x@y.z", logImpl: (l) => lines.push(l) },
      EMAIL,
    );
    expect(lines.join("\n")).not.toContain(API_KEY);
    // Anti-vacuity: the assertion above is only meaningful if something WAS printed.
    expect(lines.join("\n").length).toBeGreaterThan(0);
  });
});
