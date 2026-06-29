import { describe, expect, it } from "vitest";

import { bytesToHex, hmacSha256, utf8Encoder } from "../bytes";
import { getAdapterForScheme } from "./registry";

// W3b — Mailgun (Webhooks 2.0 / JSON mode). The signature lives in the JSON body's nested `signature`
// object: `$.signature.signature` (lowercase hex). The signed message is `{timestamp}{token}` (no
// separator), both from `$.signature.*`, HMAC-SHA256, key = the HTTP webhook signing key (utf8). No
// header, no replay window. (The legacy form-POST mode — signature as a top-level form field — is a
// separate, deprecated shape, not covered here.) Self-consistent KAT in Mailgun's exact construction.

const SIGNING_KEY = "mailgun-http-signing-key";
const TIMESTAMP = "1790000000";
const TOKEN = "mailgun-test-nonce-token";

async function mailgunSig(key: string, timestamp: string, token: string): Promise<string> {
  const mac = await hmacSha256(utf8Encoder.encode(key), utf8Encoder.encode(`${timestamp}${token}`));
  return bytesToHex(mac);
}

function body(sig: string): string {
  return JSON.stringify({
    signature: { timestamp: TIMESTAMP, token: TOKEN, signature: sig },
    "event-data": { event: "delivered", id: "evt_mailgun" },
  });
}

describe("W3b mailgun (JSON mode, sig-in-body, {timestamp}{token})", () => {
  it("exposes adyen-style (no header) metadata", () => {
    const a = getAdapterForScheme("mailgun")!;
    expect(a.scheme).toBe("mailgun");
  });

  it("verifies a correctly-signed JSON webhook", async () => {
    const sig = await mailgunSig(SIGNING_KEY, TIMESTAMP, TOKEN);
    const result = await getAdapterForScheme("mailgun")!.verify({
      rawBody: utf8Encoder.encode(body(sig)),
      headers: [["content-type", "application/json"]],
      secrets: [SIGNING_KEY],
      now: new Date(1790000000 * 1000),
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "mailgun" });
  });

  it("rejects the wrong signing key", async () => {
    const sig = await mailgunSig("the-wrong-key", TIMESTAMP, TOKEN);
    const result = await getAdapterForScheme("mailgun")!.verify({
      rawBody: utf8Encoder.encode(body(sig)),
      headers: [["content-type", "application/json"]],
      secrets: [SIGNING_KEY],
      now: new Date(1790000000 * 1000),
    });
    expect(result.ok).toBe(false);
  });

  it("is MALFORMED when the body carries no signature object", async () => {
    const result = await getAdapterForScheme("mailgun")!.verify({
      rawBody: utf8Encoder.encode('{"event-data":{"event":"opened"}}'),
      headers: [["content-type", "application/json"]],
      secrets: [SIGNING_KEY],
      now: new Date(1790000000 * 1000),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });
});
