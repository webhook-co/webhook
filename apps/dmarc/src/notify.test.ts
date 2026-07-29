import { describe, expect, it, vi } from "vitest";

import { sendAlert, type AlertTransport } from "./notify.js";

const CONFIG = {
  apiKey: "re_test_key",
  from: "dmarc-alerts@mail.webhook.co",
  to: "someone@example.com",
};

function ok(): AlertTransport {
  return vi.fn(async () => new Response("{}", { status: 200 }));
}

describe("sendAlert", () => {
  it("posts to the Resend API with bearer auth", async () => {
    const fetchImpl = ok();
    await sendAlert(CONFIG, "subject", "body", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer re_test_key");
    expect(init.headers["content-type"]).toBe("application/json");
  });

  it("carries the subject, body and addresses through unchanged", async () => {
    const fetchImpl = ok();
    await sendAlert(
      CONFIG,
      "[dmarc] webhook.co: 4 message(s) failed",
      "line one\nline two",
      fetchImpl,
    );

    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      from: "dmarc-alerts@mail.webhook.co",
      to: ["someone@example.com"],
      subject: "[dmarc] webhook.co: 4 message(s) failed",
      text: "line one\nline two",
    });
  });

  // The caller advances its "already alerted" cursor ONLY after this resolves. If a failed send resolved
  // quietly, the cursor would move past records nobody was ever told about and the alert would be lost
  // permanently — the exact silent-failure shape this whole pipeline exists to prevent.
  it("throws on a non-2xx response so the caller does not advance its cursor", async () => {
    const fetchImpl: AlertTransport = async () =>
      new Response('{"message":"invalid api key"}', { status: 401 });
    await expect(sendAlert(CONFIG, "s", "b", fetchImpl)).rejects.toThrow(/401/);
  });

  it("surfaces the provider's error body in the thrown message", async () => {
    const fetchImpl: AlertTransport = async () =>
      new Response('{"message":"domain not verified"}', { status: 403 });
    await expect(sendAlert(CONFIG, "s", "b", fetchImpl)).rejects.toThrow(/domain not verified/);
  });

  it("lets a transport-level failure propagate rather than swallowing it", async () => {
    const fetchImpl: AlertTransport = async () => {
      throw new Error("connection reset");
    };
    await expect(sendAlert(CONFIG, "s", "b", fetchImpl)).rejects.toThrow(/connection reset/);
  });
});
