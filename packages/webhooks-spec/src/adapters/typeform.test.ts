import { describe, expect, it } from "vitest";

import { hmacSha256, utf8Encoder } from "../bytes";
import { getAdapterForScheme } from "./registry";

// Typeform (S2.2 HMAC long-tail) — `Typeform-Signature: sha256=<base64>`, HMAC-SHA256 over the EXACT
// raw request body, base64-encoded, with a required `sha256=` value prefix. A Tier-1 raw-body drop-in
// missed in the S2.1 sweep. Self-consistent KAT (sign the body with a test secret, assert the
// config-driven adapter verifies) — the header name, base64 encoding, and `sha256=` prefix are what
// this locks; the crypto itself is the audited verifyHmacCore covered exhaustively elsewhere.

const HEADER = "typeform-signature";
const SECRET = "a-test-signing-secret";
const BODY = '{"event_id":"01H","event_type":"form_response"}';
const NOW = new Date("2026-06-30T00:00:00Z");

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function typeformSign(secret: string, body: string): Promise<string> {
  const mac = await hmacSha256(utf8Encoder.encode(secret), utf8Encoder.encode(body));
  return `sha256=${bytesToB64(mac)}`;
}

describe("typeform (S2.2 raw-body HMAC, sha256= base64)", () => {
  it("exposes typeform metadata", () => {
    const adapter = getAdapterForScheme("typeform")!;
    expect(adapter.scheme).toBe("typeform");
    expect(adapter.signatureHeader).toBe(HEADER);
  });

  it("verifies a base64 HMAC-SHA256 over the raw body with the sha256= prefix", async () => {
    const sig = await typeformSign(SECRET, BODY);
    const result = await getAdapterForScheme("typeform")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [[HEADER, sig]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "typeform" });
  });

  it("rejects a value missing the required sha256= prefix", async () => {
    const sig = await typeformSign(SECRET, BODY);
    const result = await getAdapterForScheme("typeform")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [[HEADER, sig.slice("sha256=".length)]], // bare base64, no prefix
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("does not verify a signature made with a different secret", async () => {
    const sig = await typeformSign("attacker-secret", BODY);
    const result = await getAdapterForScheme("typeform")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [[HEADER, sig]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("WRONG_SECRET");
  });
});
