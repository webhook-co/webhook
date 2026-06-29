import { describe, expect, it } from "vitest";

import { bytesToHex, utf8Encoder } from "../bytes";
import { getAdapterForScheme } from "./registry";

// W3a — Tier-2 providers that sign over request context (URL / method / sorted form fields), expressed
// with the F3 message-part blocks. Square uses its PUBLISHED gold vector (external oracle); the rest are
// self-consistent KATs built in each provider's exact documented message format (format-vs-docs is
// confirmed by the per-provider doc review). All sign a URL we feed from the request (see the lane note:
// for wbhk.my the request URL is the configured ingest URL).

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
async function sign(
  hash: "SHA-1" | "SHA-256",
  enc: "hex" | "base64",
  secret: string,
  message: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8Encoder.encode(secret),
    { name: "HMAC", hash },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8Encoder.encode(message)));
  return enc === "hex" ? bytesToHex(mac) : bytesToB64(mac);
}

const NOW = new Date(1790000000 * 1000);

describe("W3a square (url+body, sha256/base64) — published gold vector", () => {
  // From the square-nodejs-sdk: payload = notificationUrl + requestBody.
  const KEY = "asdf1234";
  const URL = "https://example.com/webhook";
  const BODY = '{"hello":"world"}';
  const GOLD = "2kRE5qRU2tR+tBGlDwMEw2avJ7QM4ikPYD/PJ3bd9Og=";

  it("exposes metadata", () => {
    const a = getAdapterForScheme("square")!;
    expect(a.scheme).toBe("square");
    expect(a.signatureHeader).toBe("x-square-hmacsha256-signature");
  });

  it("verifies the published vector (url-then-body)", async () => {
    const result = await getAdapterForScheme("square")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [["x-square-hmacsha256-signature", GOLD]],
      secrets: [KEY],
      requestUrl: URL,
      method: "POST",
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "square" });
  });

  it("rejects the wrong secret", async () => {
    const result = await getAdapterForScheme("square")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [["x-square-hmacsha256-signature", GOLD]],
      secrets: ["wrong"],
      requestUrl: URL,
      method: "POST",
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });
});

describe("W3a trello (body+url, sha1/base64)", () => {
  const SECRET = "trello-api-secret";
  const URL = "https://wbhk.my/whep_abc";
  const BODY = '{"action":{"type":"updateCard"}}';

  it("verifies a body-then-callbackURL signature", async () => {
    const sig = await sign("SHA-1", "base64", SECRET, `${BODY}${URL}`);
    const result = await getAdapterForScheme("trello")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [["x-trello-webhook", sig]],
      secrets: [SECRET],
      requestUrl: URL,
      method: "POST",
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "trello" });
  });
});

describe("W3a twilio (url+sortedForm, sha1/base64)", () => {
  const TOKEN = "twilio-auth-token";
  const URL = "https://wbhk.my/whep_abc?foo=1&bar=2";
  // Form body (the + in phone numbers is percent-encoded on the wire so URLSearchParams decodes it).
  const FORM = "From=%2B14158675310&Body=Hello&CallSid=CA123";
  // Documented algorithm: url + each (key+value) for keys sorted ASCII case-sensitively.
  // sorted keys: Body, CallSid, From -> "BodyHello" "CallSidCA123" "From+14158675310"
  const SIGNED = `${URL}BodyHelloCallSidCA123From+14158675310`;

  it("exposes metadata", () => {
    expect(getAdapterForScheme("twilio")!.signatureHeader).toBe("x-twilio-signature");
  });

  it("verifies url + sorted form params", async () => {
    const sig = await sign("SHA-1", "base64", TOKEN, SIGNED);
    const result = await getAdapterForScheme("twilio")!.verify({
      rawBody: utf8Encoder.encode(FORM),
      headers: [
        ["content-type", "application/x-www-form-urlencoded"],
        ["x-twilio-signature", sig],
      ],
      secrets: [TOKEN],
      requestUrl: URL,
      method: "POST",
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "twilio" });
  });
});

describe("W3a mandrill (url+sortedForm, sha1/base64)", () => {
  const KEY = "mandrill-webhook-key";
  const URL = "https://wbhk.my/whep_abc";
  const FORM = "mandrill_events=%5B%7B%22event%22%3A%22send%22%7D%5D"; // [{"event":"send"}]

  it("verifies url + sorted form params", async () => {
    const params = new URLSearchParams(FORM);
    const signed = `${URL}mandrill_events${params.get("mandrill_events")}`;
    const sig = await sign("SHA-1", "base64", KEY, signed);
    const result = await getAdapterForScheme("mandrill")!.verify({
      rawBody: utf8Encoder.encode(FORM),
      headers: [["x-mandrill-signature", sig]],
      secrets: [KEY],
      requestUrl: URL,
      method: "POST",
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "mandrill" });
  });

  it("verifies the params-less validation ping (signs just the URL)", async () => {
    const sig = await sign("SHA-1", "base64", KEY, URL);
    const result = await getAdapterForScheme("mandrill")!.verify({
      rawBody: utf8Encoder.encode(""),
      headers: [["x-mandrill-signature", sig]],
      secrets: [KEY],
      requestUrl: URL,
      method: "POST",
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });
});

describe("W3a hubspot v3 (method+url+body+ts, sha256/base64, 5-min window)", () => {
  const SECRET = "hubspot-client-secret";
  const URL = "https://wbhk.my/whep_abc";
  const BODY = '[{"eventId":1,"subscriptionType":"contact.creation"}]';
  const TS_MS = 1790000000000; // ms
  const HS_NOW = new Date(TS_MS + 2000); // 2s later — inside the 5-min window

  it("verifies method+url+body+timestamp within the window", async () => {
    const sig = await sign("SHA-256", "base64", SECRET, `POST${URL}${BODY}${TS_MS}`);
    const result = await getAdapterForScheme("hubspot")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [
        ["x-hubspot-signature-v3", sig],
        ["x-hubspot-request-timestamp", String(TS_MS)],
      ],
      secrets: [SECRET],
      requestUrl: URL,
      method: "POST",
      now: HS_NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "hubspot" });
  });

  it("rejects a timestamp older than the 5-minute window", async () => {
    const staleMs = TS_MS - 10 * 60 * 1000; // 10 min before HS_NOW
    const sig = await sign("SHA-256", "base64", SECRET, `POST${URL}${BODY}${staleMs}`);
    const result = await getAdapterForScheme("hubspot")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [
        ["x-hubspot-signature-v3", sig],
        ["x-hubspot-request-timestamp", String(staleMs)],
      ],
      secrets: [SECRET],
      requestUrl: URL,
      method: "POST",
      now: HS_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("TIMESTAMP_TOO_OLD");
  });
});
