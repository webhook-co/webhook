import { describe, expect, it } from "vitest";

import { utf8Encoder } from "../../bytes";
import { getAdapterForScheme } from "../registry";

// Twilio bespoke adapter. JSON mode uses twilio-python's published test vector (an external oracle);
// form mode is re-checked here to confirm the bespoke adapter still delegates the shipped recipe.

const NOW = new Date(1790000000 * 1000);

describe("twilio JSON / bodySHA256 mode — published vector", () => {
  // From twilio-python test_request_validator.test_validation_of_body_succeeds.
  const TOKEN = "12345";
  const BODY = '{"property": "value", "boolean": true}';
  const BODY_SHA256 = "0a1ff7634d9ab3b95db5c9a2dfe9416e41502b283a80c7cf19632632f96e6620";
  const URL = `https://mycompany.com/myapp.php?foo=1&bar=2&bodySHA256=${BODY_SHA256}`;
  const SIGNATURE = "a9nBmqA0ju/hNViExpshrM61xv4=";

  it("verifies the published vector (URL signature + body hash both pass)", async () => {
    const result = await getAdapterForScheme("twilio")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [
        ["content-type", "application/json"],
        ["x-twilio-signature", SIGNATURE],
      ],
      secrets: [TOKEN],
      requestUrl: URL,
      method: "POST",
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "twilio" });
  });

  it("flags a tampered body (URL sig valid but bodySHA256 no longer matches)", async () => {
    const result = await getAdapterForScheme("twilio")!.verify({
      rawBody: utf8Encoder.encode('{"property": "TAMPERED", "boolean": true}'),
      headers: [["x-twilio-signature", SIGNATURE]],
      secrets: [TOKEN],
      requestUrl: URL,
      method: "POST",
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("PROXY_MUTATED_BYTES");
  });

  it("rejects a wrong auth token in JSON mode", async () => {
    const result = await getAdapterForScheme("twilio")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [["x-twilio-signature", SIGNATURE]],
      secrets: ["wrong-token"],
      requestUrl: URL,
      method: "POST",
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });
});

describe("twilio form mode — still delegated by the bespoke adapter", () => {
  const TOKEN = "twilio-auth-token";
  const URL = "https://wbhk.my/whep_abc?foo=1&bar=2";
  const FORM = "From=%2B14158675310&Body=Hello&CallSid=CA123";

  it("verifies url + sorted form params (no bodySHA256)", async () => {
    // signed string = url + each (key+value) for keys sorted ASCII: Body, CallSid, From
    const signed = `${URL}BodyHelloCallSidCA123From+14158675310`;
    const sig = await hmacSha256Sha1Compat(TOKEN, signed);
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

// HMAC-SHA1/base64 helper for the form-mode KAT (the JSON KAT uses the published vector directly).
async function hmacSha256Sha1Compat(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8Encoder.encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8Encoder.encode(message)));
  let s = "";
  for (const b of mac) s += String.fromCharCode(b);
  return btoa(s);
}
