import { describe, expect, it } from "vitest";

import { bytesToHex, utf8Encoder } from "../bytes";
import { getAdapterForScheme } from "./registry";

// S8 coverage PR5 — payment/fintech HMAC providers, all config-driven (no bespoke code). KATs sign
// exactly per each provider's docs (research 2026-07-01):
//   simple raw-body : bolt (sha256/b64) · primer (sha256/b64)
//   framed          : airwallex (`{ts}{body}` NO separator, header ts) · affirm (csvKv `t=,v0=`,
//                     **SHA512**, over `{t}.{body}`)
// Deferred: Klarna (acquirer HMAC-SHA256/raw-body, but the docs don't state hex-vs-base64 encoding — a
// guess ships a fail-closed-but-wrong verifier; waits for a live delivery), Nuvei (plain SHA256/MD5
// checksum of concatenated DMN fields + prepended secret — not HMAC), Worldpay (composite
// `keyId/hashFunction/signature` header — bespoke), Spreedly (no webhook signature — HTTP Basic auth).

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
async function mac(hash: string, secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8Encoder.encode(secret),
    { name: "HMAC", hash },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8Encoder.encode(message)));
}
const enc = (b: Uint8Array, fmt: "hex" | "base64"): string =>
  fmt === "hex" ? bytesToHex(b) : bytesToB64(b);

const SECRET = "an-s8-payments-signing-secret"; // gitleaks:allow — fabricated test fixture
const BODY = '{"event":"payment.succeeded","id":"pay_1"}';
const TS = 1_790_000_000;
const NOW = new Date(TS * 1000 + 1000);

// ── simple raw-body HMAC ──────────────────────────────────────────────────────────────────────────
const RAW_BODY = [
  { slug: "bolt", header: "x-bolt-hmac-sha256", enc: "base64" as const },
  { slug: "primer", header: "x-signature-primary", enc: "base64" as const },
] as const;

describe("S8 payments — simple raw-body HMAC-SHA256", () => {
  for (const { slug, header, enc: fmt } of RAW_BODY) {
    describe(slug, () => {
      it(`exposes ${header} metadata`, () => {
        const a = getAdapterForScheme(slug)!;
        expect(a.scheme).toBe(slug);
        expect(a.signatureHeader).toBe(header);
      });

      it(`verifies a raw-body HMAC-SHA256/${fmt}`, async () => {
        const sig = enc(await mac("SHA-256", SECRET, BODY), fmt);
        const result = await getAdapterForScheme(slug)!.verify({
          rawBody: utf8Encoder.encode(BODY),
          headers: [[header, sig]],
          secrets: [SECRET],
          now: NOW,
        });
        expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: slug });
      });

      it("does not verify a tampered body", async () => {
        const sig = enc(await mac("SHA-256", SECRET, BODY), fmt);
        const result = await getAdapterForScheme(slug)!.verify({
          rawBody: utf8Encoder.encode('{"event":"payment.succeeded","id":"pay_TAMPERED"}'),
          headers: [[header, sig]],
          secrets: [SECRET],
          now: NOW,
        });
        expect(result.ok).toBe(false);
      });
    });
  }
});

// ── framed HMAC ──────────────────────────────────────────────────────────────────────────────────
describe("S8 payments — framed HMAC", () => {
  it("airwallex: HMAC-SHA256/hex over `{ts}{body}` — NO separator (x-timestamp header)", async () => {
    const sig = enc(await mac("SHA-256", SECRET, `${TS}${BODY}`), "hex");
    const result = await getAdapterForScheme("airwallex")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [
        ["x-timestamp", String(TS)],
        ["x-signature", sig],
      ],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "airwallex" });
  });

  it("airwallex: rejects a signature made WITH a `.` separator (guards the no-separator framing)", async () => {
    const sig = enc(await mac("SHA-256", SECRET, `${TS}.${BODY}`), "hex"); // wrong: has a dot
    const result = await getAdapterForScheme("airwallex")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [
        ["x-timestamp", String(TS)],
        ["x-signature", sig],
      ],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });

  it("affirm: HMAC-SHA512/hex over `{t}.{body}`, csvKv `t=..,v0=..`", async () => {
    const sig = enc(await mac("SHA-512", SECRET, `${TS}.${BODY}`), "hex");
    const result = await getAdapterForScheme("affirm")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [["x-affirm-signature", `t=${TS},v0=${sig}`]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "affirm" });
  });

  it("affirm: rejects a SHA-256 signature (guards the SHA-512 digest)", async () => {
    const sig = enc(await mac("SHA-256", SECRET, `${TS}.${BODY}`), "hex"); // wrong digest
    const result = await getAdapterForScheme("affirm")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [["x-affirm-signature", `t=${TS},v0=${sig}`]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });
});
