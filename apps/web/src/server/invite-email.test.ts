import { describe, expect, it, vi } from "vitest";

import { sendInviteEmail } from "./invite-email";

function okFetch() {
  return vi.fn(async () => new Response("{}", { status: 200 }));
}

const MSG = {
  to: "bob@acme.test",
  url: "https://app.webhook.co/invite/accept?org=org_1&token=whinv_secret",
  invitedBy: "olive@acme.test",
};

describe("sendInviteEmail", () => {
  it("posts to Resend with the recipient, the link, and a bearer key", async () => {
    const fetchImpl = okFetch();
    await sendInviteEmail({ apiKey: "re_key", from: "invites@mail.webhook.co", fetchImpl }, MSG);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_key");
    const body = JSON.parse(String(init.body));
    expect(body.to).toBe("bob@acme.test");
    expect(body.from).toBe("invites@mail.webhook.co");
    // In the HTML the href carries the URL with `&` entity-escaped — that IS the correct encoding, and the
    // browser requests the original URL. The plain-text part carries it verbatim.
    expect(body.html).toContain(MSG.url.replaceAll("&", "&amp;"));
    expect(body.text).toContain(MSG.url);
    // The inviter is named so the recipient can judge whether they expected this.
    expect(body.html).toContain("olive@acme.test");
  });

  it("ESCAPES the inviter's email into the HTML — it is user-controlled", async () => {
    const fetchImpl = okFetch();
    await sendInviteEmail(
      { apiKey: "re_key", from: "invites@mail.webhook.co", fetchImpl },
      { ...MSG, invitedBy: '<img src=x onerror="alert(1)">@evil.test' },
    );
    const body = JSON.parse(
      String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    // The invariant that matters: it can never become a TAG or break out of an ATTRIBUTE. (The literal text
    // "onerror=" surviving as inert prose is harmless — it is the angle brackets and quotes that would make
    // it executable.)
    //
    // This pins the PAYLOAD, not the document. It used to assert the html contained no "<img" at all, which
    // was a valid proxy only while the email had no images of its own; the branded shell now carries a logo
    // <img>, so a document-wide assertion would fail on our own markup while proving nothing about the
    // injected value. Naming the payload is strictly stronger — it survives the shell gaining more markup.
    expect(body.html).not.toContain('<img src=x onerror="alert(1)">');
    expect(body.html).not.toContain('onerror="alert(1)"');
    expect(body.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("renders the branded shell — logo, text wordmark, and a dark CTA to the invite", async () => {
    const fetchImpl = okFetch();
    await sendInviteEmail({ apiKey: "re_key", from: "invites@mail.webhook.co", fetchImpl }, MSG);
    const body = JSON.parse(
      String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect(body.html).toContain('src="https://www.webhook.co/logo.png"');
    // The wordmark is text, so a client blocking the remote logo still shows the brand.
    expect(body.html).toContain(">webhook</span>");
    expect(body.html).toContain("background-color:#18181b");
  });

  it("throws on a non-2xx WITHOUT leaking the api key", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 422 }));
    await expect(
      sendInviteEmail(
        { apiKey: "re_supersecret", from: "invites@mail.webhook.co", fetchImpl },
        MSG,
      ),
    ).rejects.toThrow(/422/);
    await expect(
      sendInviteEmail(
        { apiKey: "re_supersecret", from: "invites@mail.webhook.co", fetchImpl },
        MSG,
      ),
    ).rejects.not.toThrow(/re_supersecret/);
  });
});
