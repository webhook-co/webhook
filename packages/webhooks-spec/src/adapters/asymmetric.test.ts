import { describe, expect, it } from "vitest";

import { b64ToBytes, hexToBytes, utf8Encoder } from "../bytes";
import {
  derEcdsaSigToRaw,
  pemToDer,
  verifyEcdsaP256Sha1,
  verifyEcdsaP256Sha256,
  verifyEd25519,
  verifyRsaPkcs1Sha256,
} from "./asymmetric";

// A0a — the asymmetric (public-key) verify primitives. This file covers Ed25519 (Discord, Telnyx);
// ECDSA-P256 + RSA land with their providers. Anchored on Discord's reproduced gold vector: a 32-byte hex
// public key, the signed message `timestamp + rawBody` (no separator), and a 64-byte hex signature.

// Reproduced deterministic Discord vector (public key + signature over `1610000000{"type":1}`).
// PUBLIC reproduced Discord vector (an app public key + a signature) — not a private credential.
const PUB = hexToBytes(
  "79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664", // gitleaks:allow
)!;
const SIG = hexToBytes(
  "50db4086e890c41c26b539f0dd95af18b4d8b03d2f4203964d238b4946943ee2cc6fd52c47ddb355d267086a8c4e299d1054d3d655dba6e0f237a779f634800d", // gitleaks:allow
)!;
const MSG = utf8Encoder.encode('1610000000{"type":1}');

describe("verifyEd25519", () => {
  it("verifies a valid Ed25519 signature (Discord gold vector)", async () => {
    expect(await verifyEd25519(PUB, MSG, SIG)).toBe(true);
  });

  it("rejects a tampered message", async () => {
    expect(await verifyEd25519(PUB, utf8Encoder.encode('1610000000{"type":2}'), SIG)).toBe(false);
  });

  it("rejects a tampered signature", async () => {
    const bad = SIG.slice();
    bad[0] ^= 0xff;
    expect(await verifyEd25519(PUB, MSG, bad)).toBe(false);
  });

  it("rejects a signature made under a different key", async () => {
    const otherKey = hexToBytes(
      "0000000000000000000000000000000000000000000000000000000000000001",
    )!;
    expect(await verifyEd25519(otherKey, MSG, SIG)).toBe(false);
  });

  it("returns false (never throws) on wrong-length key or signature", async () => {
    expect(await verifyEd25519(PUB.slice(0, 31), MSG, SIG)).toBe(false);
    expect(await verifyEd25519(PUB, MSG, SIG.slice(0, 63))).toBe(false);
    expect(await verifyEd25519(new Uint8Array(0), MSG, SIG)).toBe(false);
  });
});

// SendGrid gold vector (ECDSA P-256/SHA-256; DER signature, base64 SPKI public key; msg = timestamp+body
// where the body has a trailing CRLF). All PUBLIC values from SendGrid's SDK test suites.
const SG_KEY_B64 =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE83T4O/n84iotIvIW4mdBgQ/7dAfSmpqIM8kF9mN1flpVKS3GRqe62gw+2fNNRaINXvVpiglSI8eNEc6wEA3F+g=="; // gitleaks:allow
const SG_SIG_DER_B64 =
  "MEUCIGHQVtGj+Y3LkG9fLcxf3qfI10QysgDWmMOVmxG0u6ZUAiEAyBiXDWzM+uOe5W0JuG+luQAbPIqHh89M15TluLtEZtM="; // gitleaks:allow
const SG_TS = "1600112502";
const SG_BODY =
  '[{"email":"hello@world.com","event":"dropped","reason":"Bounced Address","sg_event_id":"ZHJvcC0xMDk5NDkxOS1MUnpYbF9OSFN0T0doUTRrb2ZTbV9BLTA","sg_message_id":"LRzXl_NHStOGhQ4kofSm_A.filterdrecv-p3mdw1-756b745b58-kmzbl-18-5F5FC76C-9.0","smtp-id":"<LRzXl_NHStOGhQ4kofSm_A@ismtpd0039p1iad1.sendgrid.net>","timestamp":1600112492}]\r\n';

describe("verifyEcdsaP256Sha256 + derEcdsaSigToRaw", () => {
  it("verifies SendGrid's gold vector (DER signature converted to raw r||s)", async () => {
    const raw = derEcdsaSigToRaw(b64ToBytes(SG_SIG_DER_B64)!);
    expect(raw).not.toBeNull();
    expect(raw!.length).toBe(64);
    const ok = await verifyEcdsaP256Sha256(
      b64ToBytes(SG_KEY_B64)!,
      utf8Encoder.encode(SG_TS + SG_BODY),
      raw!,
    );
    expect(ok).toBe(true);
  });

  it("rejects a tampered timestamp", async () => {
    const raw = derEcdsaSigToRaw(b64ToBytes(SG_SIG_DER_B64)!)!;
    expect(
      await verifyEcdsaP256Sha256(
        b64ToBytes(SG_KEY_B64)!,
        utf8Encoder.encode(`1600112503${SG_BODY}`),
        raw,
      ),
    ).toBe(false);
  });

  it("rejects a non-64-byte raw signature before touching crypto", async () => {
    expect(
      await verifyEcdsaP256Sha256(
        b64ToBytes(SG_KEY_B64)!,
        utf8Encoder.encode("x"),
        new Uint8Array(10),
      ),
    ).toBe(false);
  });

  it("derEcdsaSigToRaw returns null on malformed DER (never throws)", () => {
    expect(derEcdsaSigToRaw(new Uint8Array(0))).toBeNull();
    expect(derEcdsaSigToRaw(new Uint8Array([0x01, 0x02, 0x03]))).toBeNull(); // not a SEQUENCE
    expect(derEcdsaSigToRaw(new Uint8Array([0x30, 0x02, 0x02, 0x7f]))).toBeNull(); // truncated INTEGER
  });
});

describe("verifyEcdsaP256Sha1 (eBay Event Notification signatures — SHA1withECDSA)", () => {
  // eBay signs notifications with ECDSA-P256 over SHA-1 (its `digest` field is literally SHA1). No public
  // gold vector exists, so we self-generate a P-256 keypair, sign with SHA-1, and verify — proving the
  // SHA-1 hash wiring + SPKI import. (The DER→raw conversion is covered by derEcdsaSigToRaw above; the eBay
  // adapter chains them.)
  it("verifies a self-signed ECDSA-P256 + SHA-1 signature against the signer's SPKI key, rejects tampering", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const message = utf8Encoder.encode('{"metadata":{"topic":"MARKETPLACE_ACCOUNT_DELETION"}}');
    const rawSig = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-1" }, kp.privateKey, message),
    );
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
    expect(await verifyEcdsaP256Sha1(spki, message, rawSig)).toBe(true);
    expect(await verifyEcdsaP256Sha1(spki, utf8Encoder.encode("tampered body"), rawSig)).toBe(
      false,
    );
  });

  it("returns false (never throws) for a non-64-byte raw signature and for junk SPKI", async () => {
    expect(
      await verifyEcdsaP256Sha1(new Uint8Array(91), utf8Encoder.encode("x"), new Uint8Array(10)),
    ).toBe(false);
    expect(
      await verifyEcdsaP256Sha1(new Uint8Array(5), utf8Encoder.encode("x"), new Uint8Array(64)),
    ).toBe(false);
  });
});

// Wise gold vector (RSASSA-PKCS1-v1_5 SHA-256; base64 sig over the raw body; PEM SPKI key — sandbox).
// PUBLIC values from transferwise/digital-signatures-examples + Wise's published sandbox key.
const WISE_BODY =
  '{"data":{"resource":{"id":49983981,"profile_id":16055450,"account_id":14124090,"type":"transfer"},"current_state":"incoming_payment_waiting","previous_state":null,"occurred_at":"2021-08-23T10:12:50Z"},"subscription_id":"90aa8e14-4ef1-4a56-861c-f3c9cde097ea","event_type":"transfers#state-change","schema_version":"2.0.0","sent_at":"2021-08-23T10:12:50Z"}';
const WISE_SIG_B64 =
  "wKcKCYXAzxNgiu7xmoDm943NUni7Rz33QN8JkEA9dWSGebgndonabgSj18Y4C08OrwVmueGsED2s00M7DtJVcYKOS1i3G4TMVx+mgM3aL9djMBkQtiYNBFUd6wrPI7ZUNHv/TrlKSjTMc+6JFvUvJ7owY3z85e3I4jLRLJowMFvO8kvCJ60+1pY9wDwZvtZ//WS93LrwGjk9Dvwzpmu0w+P4J75tETT5qC3Uv0y5G2yO8SEoO3yNP/tg/BOli02niHb53vEOUWUb9bly6thnfMoXoiV/osoGxgF20R58RlvkAmezyyl1Sv542TfS2DpiwVnmjjjkCyXeSUcKookYLQ=="; // gitleaks:allow
const WISE_SANDBOX_PEM = [
  "-----BEGIN PUBLIC KEY-----", // gitleaks:allow (Wise's PUBLIC sandbox key)
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwpb91cEYuyJNQepZAVfP",
  "ZIlPZfNUefH+n6w9SW3fykqKu938cR7WadQv87oF2VuT+fDt7kqeRziTmPSUhqPU",
  "ys/V2Q1rlfJuXbE+Gga37t7zwd0egQ+KyOEHQOpcTwKmtZ81ieGHynAQzsn1We3j",
  "wt760MsCPJ7GMT141ByQM+yW1Bx+4SG3IGjXWyqOWrcXsxAvIXkpUD/jK/L958Cg",
  "nZEgz0BSEh0QxYLITnW1lLokSx/dTianWPFEhMC9BgijempgNXHNfcVirg1lPSyg",
  "z7KqoKUN0oHqWLr2U1A+7kqrl6O2nx3CKs1bj1hToT1+p4kcMoHXA7kA+VBLUpEs",
  "VwIDAQAB",
  "-----END PUBLIC KEY-----",
].join("\n");

describe("verifyRsaPkcs1Sha256 + pemToDer", () => {
  it("verifies Wise's gold vector (PEM SPKI key, base64 sig over the raw body)", async () => {
    const spki = pemToDer(WISE_SANDBOX_PEM);
    expect(spki).not.toBeNull();
    expect(
      await verifyRsaPkcs1Sha256(spki!, utf8Encoder.encode(WISE_BODY), b64ToBytes(WISE_SIG_B64)!),
    ).toBe(true);
  });

  it("rejects a tampered body", async () => {
    expect(
      await verifyRsaPkcs1Sha256(
        pemToDer(WISE_SANDBOX_PEM)!,
        utf8Encoder.encode(`${WISE_BODY} `),
        b64ToBytes(WISE_SIG_B64)!,
      ),
    ).toBe(false);
  });

  it("pemToDer returns null on non-PEM input (never throws)", () => {
    expect(pemToDer("not a pem at all")).toBeNull();
    expect(pemToDer("")).toBeNull();
  });
});
