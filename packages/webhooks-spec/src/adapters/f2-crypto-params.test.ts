import { describe, expect, it } from "vitest";

import { b64urlToBytes, bytesToHex, utf8Encoder } from "../bytes";
import { toCandidates, verifyHmac } from "./shared";

// F2 — engine crypto parameterization. The verify engine must support digests beyond SHA-256
// (SHA-1 = 20-byte MAC, SHA-512 = 64-byte MAC) and a base64url signature encoding, on top of the
// existing hex/base64 + SHA-256. These are the two orthogonal axes W2 providers need (vercel/intercom
// = sha1, authorize_net/paystack = sha512, sanity = base64url). Each KAT signs INDEPENDENTLY via raw
// crypto.subtle (not the verify path's own key-import) so it's a true cross-check, not self-consistency.

const SECRET = "f2-test-secret";
const BODY = '{"event":"f2","id":"evt_f2"}';

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function bytesToB64url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signMac(hash: string, secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8Encoder.encode(secret),
    { name: "HMAC", hash },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8Encoder.encode(message)));
}

const RAW = utf8Encoder.encode(BODY);
const rawBodyMessage = (body: Uint8Array): Uint8Array => body;

describe("b64urlToBytes", () => {
  it("round-trips base64url (URL-safe alphabet, no padding)", () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x01, 0x02, 0x03]);
    const encoded = bytesToB64url(bytes);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
    expect([...b64urlToBytes(encoded)!]).toEqual([...bytes]);
  });

  it("rejects standard-base64 `+` / `/` characters (those are base64, not base64url)", () => {
    expect(b64urlToBytes("ab+d")).toBeNull();
    expect(b64urlToBytes("ab/d")).toBeNull();
  });

  it("returns null on an impossible length (≡ 1 mod 4), never throws", () => {
    expect(b64urlToBytes("A")).toBeNull();
  });

  it("accepts the URL-safe `-` and `_` characters", () => {
    // `-_` is the base64url form of `+/`; it must decode (to 0xfb, 0xff…), not be rejected.
    expect(b64urlToBytes("-_")).not.toBeNull();
  });
});

describe("verifyHmac digest × encoding matrix", () => {
  const DIGESTS = [
    ["sha1", "SHA-1"],
    ["sha256", "SHA-256"],
    ["sha512", "SHA-512"],
  ] as const;

  for (const [digest, hash] of DIGESTS) {
    it(`verifies a ${digest} signature carried as hex`, async () => {
      const mac = await signMac(hash, SECRET, BODY);
      const result = await verifyHmac({
        scheme: "github",
        rawBody: RAW,
        signatures: [bytesToHex(mac)],
        encoding: "hex",
        digest,
        candidates: toCandidates([SECRET]),
        buildMessage: rawBodyMessage,
      });
      expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "github" });
    });
  }

  it("verifies a SHA-256 signature carried as base64url (sanity-style encoding)", async () => {
    const mac = await signMac("SHA-256", SECRET, BODY);
    const result = await verifyHmac({
      scheme: "github",
      rawBody: RAW,
      signatures: [bytesToB64url(mac)],
      encoding: "base64url",
      digest: "sha256",
      candidates: toCandidates([SECRET]),
      buildMessage: rawBodyMessage,
    });
    expect(result.ok).toBe(true);
  });

  it("verifies a SHA-512 signature carried as base64 (encoding × digest cross-product)", async () => {
    const mac = await signMac("SHA-512", SECRET, BODY);
    const result = await verifyHmac({
      scheme: "github",
      rawBody: RAW,
      signatures: [bytesToB64(mac)],
      encoding: "base64",
      digest: "sha512",
      candidates: toCandidates([SECRET]),
      buildMessage: rawBodyMessage,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects under the wrong digest — a 32-byte SHA-256 MAC can't match a SHA-512 verify", async () => {
    const mac = await signMac("SHA-256", SECRET, BODY);
    const result = await verifyHmac({
      scheme: "github",
      rawBody: RAW,
      signatures: [bytesToHex(mac)],
      encoding: "hex",
      digest: "sha512",
      candidates: toCandidates([SECRET]),
      buildMessage: rawBodyMessage,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("SIGNATURE_MISMATCH");
  });

  it("rejects a non-base64url signature as MALFORMED (never throws)", async () => {
    const result = await verifyHmac({
      scheme: "github",
      rawBody: RAW,
      signatures: ["not+valid/url"],
      encoding: "base64url",
      digest: "sha256",
      candidates: toCandidates([SECRET]),
      buildMessage: rawBodyMessage,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });
});
