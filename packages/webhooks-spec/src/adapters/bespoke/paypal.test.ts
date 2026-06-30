import { describe, expect, it } from "vitest";

import type { KeyFetchSpec } from "../../adapter";
import { crc32, utf8Encoder } from "../../bytes";
import { getAdapterForScheme } from "../registry";
import { x509SpkiFromDer } from "../x509";

// PayPal — RSA-PKCS1/SHA-256 over `id|time|webhookId|crc32(body)`; the public key is an X.509 cert fetched
// from PAYPAL-CERT-URL. No private key lives in the repo: we generate an RSA keypair at runtime and wrap its
// exported SPKI in a structurally-valid (minimal) X.509 cert so x509SpkiFromDer can walk it out.

const ID = "69cd13f0-d67a-11e5-baa3-778b53f4ae55";
const TIME = "2026-06-30T20:01:35Z";
const WEBHOOK_ID = "1JE4291016473214C";
const CERT_URL = "https://api.paypal.com/v1/notifications/certs/CERT-abc-123";
const BODY = '{"id":"WH-1","event_type":"PAYMENT.SALE.COMPLETED"}';

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function concat(...arrays: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrays) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}
function derLen(n: number): number[] {
  if (n < 128) return [n];
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return [0x80 | bytes.length, ...bytes];
}
function tlv(tag: number, content: Uint8Array): Uint8Array {
  return concat(new Uint8Array([tag, ...derLen(content.length)]), content);
}
const seq = (...parts: Uint8Array[]) => tlv(0x30, concat(...parts));

/** A runtime keypair + a minimal cert PEM wrapping its SPKI + a signer for the PayPal message. */
async function setup(): Promise<{
  certPem: string;
  certDer: Uint8Array;
  spkiDer: Uint8Array;
  sign: (message: string) => Promise<string>;
}> {
  const kp = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const spkiDer = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
  // SEQUENCE { tbs SEQUENCE { INTEGER serial, SEQ sigAlg, SEQ issuer, SEQ validity, SEQ subject, <SPKI> },
  //           SEQ sigAlg, BIT STRING sig } — contents of the skipped fields are arbitrary (the parser skips
  //           by TLV length), the SPKI is the only field that must be real.
  const tbs = seq(tlv(0x02, new Uint8Array([1])), seq(), seq(), seq(), seq(), spkiDer);
  const certDer = seq(tbs, seq(), tlv(0x03, new Uint8Array([0x00])));
  const certPem = `-----BEGIN CERTIFICATE-----\n${b64(certDer)}\n-----END CERTIFICATE-----`;
  const sign = async (message: string): Promise<string> =>
    b64(
      new Uint8Array(
        await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, utf8Encoder.encode(message)),
      ),
    );
  return { certPem, certDer, spkiDer, sign };
}

function headers(sig: string, over: Partial<Record<string, string>> = {}) {
  return Object.entries({
    "paypal-transmission-sig": sig,
    "paypal-transmission-id": ID,
    "paypal-transmission-time": TIME,
    "paypal-cert-url": CERT_URL,
    ...over,
  }) as [string, string][];
}
async function paypalMessage(sign: (m: string) => Promise<string>): Promise<string> {
  const crc = crc32(utf8Encoder.encode(BODY)).toString();
  return sign(`${ID}|${TIME}|${WEBHOOK_ID}|${crc}`);
}

describe("x509SpkiFromDer", () => {
  it("extracts the SPKI from an X.509 cert (round-trips the exported key)", async () => {
    const { certDer, spkiDer } = await setup();
    expect(x509SpkiFromDer(certDer)).toEqual(spkiDer);
  });
  it("returns null on malformed cert DER (never throws)", () => {
    expect(x509SpkiFromDer(new Uint8Array(0))).toBeNull();
    expect(x509SpkiFromDer(new Uint8Array([0x30, 0x02, 0x05, 0x00]))).toBeNull(); // SEQ but no tbs SPKI
    expect(x509SpkiFromDer(new Uint8Array([0x02, 0x01, 0x01]))).toBeNull(); // not a SEQUENCE
  });
});

describe("paypal bespoke (RSA cert-URL, crc32 message)", () => {
  it("exposes paypal metadata", () => {
    const adapter = getAdapterForScheme("paypal")!;
    expect(adapter.scheme).toBe("paypal");
    expect(adapter.signatureHeader).toBe("paypal-transmission-sig");
  });

  it("verifies a transmission (fetched cert, crc32 message)", async () => {
    const { certPem, sign } = await setup();
    const sig = await paypalMessage(sign);
    const fetchKey = async (spec: KeyFetchSpec) => {
      expect(spec.url).toBe(CERT_URL);
      expect(spec.allowedHosts).toEqual(["api.paypal.com", "api.sandbox.paypal.com"]);
      return utf8Encoder.encode(certPem);
    };
    const result = await getAdapterForScheme("paypal")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: [WEBHOOK_ID],
      fetchKey,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "paypal" });
  });

  it("rejects a tampered body (crc32 no longer matches) as SIGNATURE_MISMATCH", async () => {
    const { certPem, sign } = await setup();
    const sig = await paypalMessage(sign);
    const result = await getAdapterForScheme("paypal")!.verify({
      rawBody: utf8Encoder.encode(`${BODY} `),
      headers: headers(sig),
      secrets: [WEBHOOK_ID],
      fetchKey: async () => utf8Encoder.encode(certPem),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("SIGNATURE_MISMATCH");
  });

  it("rejects a wrong webhook id as SIGNATURE_MISMATCH", async () => {
    const { certPem, sign } = await setup();
    const sig = await paypalMessage(sign);
    const result = await getAdapterForScheme("paypal")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: ["WRONG-WEBHOOK-ID"],
      fetchKey: async () => utf8Encoder.encode(certPem),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("SIGNATURE_MISMATCH");
  });

  it("rejects an untrusted cert URL (wrong host/path) as SIGNATURE_MISMATCH", async () => {
    const { certPem, sign } = await setup();
    const sig = await paypalMessage(sign);
    const result = await getAdapterForScheme("paypal")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig, { "paypal-cert-url": "https://evil.example/v1/notifications/certs/x" }),
      secrets: [WEBHOOK_ID],
      fetchKey: async () => utf8Encoder.encode(certPem),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("SIGNATURE_MISMATCH");
  });

  it("fails soft to KEY_FETCH_FAILED when the cert can't be fetched", async () => {
    const { sign } = await setup();
    const sig = await paypalMessage(sign);
    const result = await getAdapterForScheme("paypal")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: [WEBHOOK_ID],
      fetchKey: async () => null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("KEY_FETCH_FAILED");
  });

  it("reports MISSING_HEADER when a PayPal header is absent", async () => {
    const { certPem, sign } = await setup();
    const sig = await paypalMessage(sign);
    const result = await getAdapterForScheme("paypal")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [
        ["paypal-transmission-sig", sig],
        ["paypal-transmission-id", ID],
        ["paypal-cert-url", CERT_URL],
      ], // no transmission-time
      secrets: [WEBHOOK_ID],
      fetchKey: async () => utf8Encoder.encode(certPem),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MISSING_HEADER");
  });
});
