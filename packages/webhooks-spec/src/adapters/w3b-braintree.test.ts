import { describe, expect, it } from "vitest";

import { bytesToHex, utf8Encoder } from "../bytes";
import { getAdapterForScheme } from "./registry";

// W3b — Braintree. Two form fields: `bt_signature` = `publicKey|sig&publicKey|sig` pairs (one per
// active key; we match ANY since our key only produces our pair's sig) and `bt_payload` = a base64
// string (signed VERBATIM, including the trailing newline Braintree's base64 encoder appends). The HMAC
// key is the SHA-1 RAW 20 BYTES of the private key (NOT hex, NOT the key itself); HMAC-SHA1, lowercase
// hex. This KAT mirrors Braintree's own signer (braintree_python webhook_testing_gateway) — the
// strongest available oracle since no static vector is published.

const PRIVATE_KEY = "test-private-key-value";
const PUBLIC_KEY = "test_public_key";
const PAYLOAD = `${btoa("<notification><kind>check</kind></notification>")}\n`; // encodebytes appends \n

async function btSign(privateKey: string, payload: string): Promise<string> {
  // key = SHA-1 raw bytes of the private key
  const keyBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-1", utf8Encoder.encode(privateKey)),
  );
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", hmacKey, utf8Encoder.encode(payload));
  return bytesToHex(new Uint8Array(mac));
}

function formBody(btSignature: string, payload: string): Uint8Array {
  return utf8Encoder.encode(
    new URLSearchParams({ bt_signature: btSignature, bt_payload: payload }).toString(),
  );
}

const NOW = new Date(1790000000 * 1000);
const HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["content-type", "application/x-www-form-urlencoded"],
];

describe("W3b braintree (bt_signature pairs + SHA1(private_key) key)", () => {
  it("exposes braintree metadata", () => {
    expect(getAdapterForScheme("braintree")!.scheme).toBe("braintree");
  });

  it("verifies a single-pair signature over the raw bt_payload", async () => {
    const sig = await btSign(PRIVATE_KEY, PAYLOAD);
    const result = await getAdapterForScheme("braintree")!.verify({
      rawBody: formBody(`${PUBLIC_KEY}|${sig}`, PAYLOAD),
      headers: HEADERS,
      secrets: [PRIVATE_KEY],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "braintree" });
  });

  it("verifies when our pair is one of several (key rotation; match-any)", async () => {
    const sig = await btSign(PRIVATE_KEY, PAYLOAD);
    const btSignature = `other_public_key|${"a".repeat(40)}&${PUBLIC_KEY}|${sig}`;
    const result = await getAdapterForScheme("braintree")!.verify({
      rawBody: formBody(btSignature, PAYLOAD),
      headers: HEADERS,
      secrets: [PRIVATE_KEY],
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a signature from the wrong private key", async () => {
    const sig = await btSign("the-wrong-private-key", PAYLOAD);
    const result = await getAdapterForScheme("braintree")!.verify({
      rawBody: formBody(`${PUBLIC_KEY}|${sig}`, PAYLOAD),
      headers: HEADERS,
      secrets: [PRIVATE_KEY],
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });

  it("is MALFORMED when bt_signature is absent", async () => {
    const result = await getAdapterForScheme("braintree")!.verify({
      rawBody: utf8Encoder.encode(new URLSearchParams({ bt_payload: PAYLOAD }).toString()),
      headers: HEADERS,
      secrets: [PRIVATE_KEY],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("REJECTS an oracle-domain bt_payload even with a byte-perfect HMAC (bt_challenge handshake-replay guard)", async () => {
    // The bt_challenge GET handshake HMACs a short hex nonce under this SAME SHA1(private_key). An attacker
    // who never learns the private key GETs `pubkey|HMAC(nonce)` and replays it here as bt_signature over
    // bt_payload=nonce — the HMAC is GENUINE, so key-based verify alone would pass. The domain-separation
    // guard (rejectSignedMessageMatching) fails it closed: a bt_payload matching ^[a-f0-9]{20,40}$ is refused.
    const nonce = "20f9f8ed05f77439fe955c977e4c8a53";
    const genuineSig = await btSign(PRIVATE_KEY, nonce); // Braintree's own key over the nonce
    const result = await getAdapterForScheme("braintree")!.verify({
      rawBody: formBody(`${PUBLIC_KEY}|${genuineSig}`, nonce),
      headers: HEADERS,
      secrets: [PRIVATE_KEY],
      now: NOW,
    });
    expect(result.ok).toBe(false); // rejected despite a valid HMAC — the payload is in the oracle domain
  });

  it("does NOT reject a real (long base64) bt_payload that merely starts with hex chars", async () => {
    // Regression: real bt_payloads are long base64 XML and never match ^[a-f0-9]{20,40}$ end-to-end, so the
    // guard must not touch them. PAYLOAD is base64+`\n` (has uppercase / `<`-free but `=`/newline, and >40).
    const sig = await btSign(PRIVATE_KEY, PAYLOAD);
    const result = await getAdapterForScheme("braintree")!.verify({
      rawBody: formBody(`${PUBLIC_KEY}|${sig}`, PAYLOAD),
      headers: HEADERS,
      secrets: [PRIVATE_KEY],
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });
});
