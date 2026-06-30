import { describe, expect, it } from "vitest";

import { utf8Encoder } from "../../bytes";
import { getAdapterForScheme } from "../registry";

// Telnyx — Ed25519 over `timestamp + "|" + rawBody` (a literal pipe separator). Headers
// `telnyx-signature-ed25519` (base64 64-byte sig) + `telnyx-timestamp`. The registered "secret" is the
// account's base64-encoded 32-byte public key. No published vector → self-minted KAT.

const SIG_HEADER = "telnyx-signature-ed25519";
const TS_HEADER = "telnyx-timestamp";
const TS = "1790000000";
const BODY = '{"data":{"event_type":"call.initiated"}}';
const NOW = new Date(1790000000 * 1000);

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Mint a Telnyx-shaped signature for `body` under a fresh keypair; returns the base64 pubkey + sig. */
async function mint(body: string): Promise<{ pubKeyB64: string; sigB64: string }> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const msg = utf8Encoder.encode(`${TS}|${body}`);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, msg));
  return { pubKeyB64: b64(raw), sigB64: b64(sig) };
}

describe("telnyx bespoke (Ed25519 over timestamp|body)", () => {
  it("exposes telnyx metadata", () => {
    const adapter = getAdapterForScheme("telnyx")!;
    expect(adapter.scheme).toBe("telnyx");
    expect(adapter.signatureHeader).toBe(SIG_HEADER);
  });

  it("verifies a base64 Ed25519 signature over timestamp|body", async () => {
    const { pubKeyB64, sigB64 } = await mint(BODY);
    const result = await getAdapterForScheme("telnyx")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [
        [SIG_HEADER, sigB64],
        [TS_HEADER, TS],
      ],
      secrets: [pubKeyB64],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "telnyx" });
  });

  it("rejects a tampered body as SIGNATURE_MISMATCH", async () => {
    const { pubKeyB64, sigB64 } = await mint(BODY);
    const result = await getAdapterForScheme("telnyx")!.verify({
      rawBody: utf8Encoder.encode('{"data":{"event_type":"call.hangup"}}'),
      headers: [
        [SIG_HEADER, sigB64],
        [TS_HEADER, TS],
      ],
      secrets: [pubKeyB64],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("SIGNATURE_MISMATCH");
  });

  it("rejects a signature under a different key as SIGNATURE_MISMATCH", async () => {
    const { sigB64 } = await mint(BODY);
    const other = await mint(BODY); // different keypair's public key
    const result = await getAdapterForScheme("telnyx")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [
        [SIG_HEADER, sigB64],
        [TS_HEADER, TS],
      ],
      secrets: [other.pubKeyB64],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("SIGNATURE_MISMATCH");
  });

  it("reports MISSING_HEADER when the timestamp header is absent", async () => {
    const { pubKeyB64, sigB64 } = await mint(BODY);
    const result = await getAdapterForScheme("telnyx")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [[SIG_HEADER, sigB64]],
      secrets: [pubKeyB64],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MISSING_HEADER");
  });
});
