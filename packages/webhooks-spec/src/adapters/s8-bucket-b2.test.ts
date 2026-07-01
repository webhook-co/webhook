import { describe, expect, it } from "vitest";

import { bytesToHex, hexToBytes, utf8Encoder } from "../bytes";
import { getAdapterForScheme } from "./registry";

// S8 coverage PR4 — more Bucket-B quirk-HMAC providers, all config-driven (no bespoke code). KATs sign
// exactly per each provider's docs (research 2026-07-01). Watch-outs baked into the vectors:
//   MS Teams   — `authorization: HMAC <b64>` (literal "HMAC " prefix, key is base64-DECODED)
//   Squarespace— key is a HEX string decoded to bytes
//   LinkedIn   — signs `"hmacsha256=" + body` (a literal on the MESSAGE, not a header prefix)
//   TikTok     — csvKv `t=..,s=..` (sig key is `s`, not `v1`)
// Deferred: Plaid (ES256 JWT + JWKS — bespoke), TikTok Shop (docs JS-gated, unverified), and LinkedIn's
// GET `?challengeCode=` registration handshake (a follow-up for the handshake dispatcher).

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
async function mac(hash: string, keyBytes: Uint8Array, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8Encoder.encode(message)));
}
const enc = (b: Uint8Array, fmt: "hex" | "base64"): string =>
  fmt === "hex" ? bytesToHex(b) : bytesToB64(b);

const BODY = '{"event":"bucket.b2","id":"evt_b2"}';
const TS = 1_790_000_000;
const NOW = new Date(TS * 1000 + 1000);

// Secrets by key-derivation kind (fabricated fixtures, not credentials).
const UTF8_SECRET = "an-s8-b2-signing-secret"; // gitleaks:allow — fake test fixture
const utf8Key = utf8Encoder.encode(UTF8_SECRET);
const MSTEAMS_KEY = utf8Encoder.encode("ms-teams-key-material-32-bytes!!!");
const MSTEAMS_SECRET = bytesToB64(MSTEAMS_KEY); // the registered secret is the base64 of the key
const SQSP_HEX_SECRET = "abcdef0123456789abcdef0123456789abcdef0123456789"; // gitleaks:allow — fake fixture
const sqspKey = hexToBytes(SQSP_HEX_SECRET)!;

// ── simple raw-body HMAC (varied key derivation + value prefix) ─────────────────────────────────────
const RAW_BODY = [
  {
    slug: "ms_teams",
    header: "authorization",
    prefix: "HMAC ",
    sigEnc: "base64" as const,
    secret: MSTEAMS_SECRET,
    keyBytes: MSTEAMS_KEY,
  },
  {
    slug: "ably",
    header: "x-ably-signature",
    prefix: "",
    sigEnc: "base64" as const,
    secret: UTF8_SECRET,
    keyBytes: utf8Key,
  },
  {
    slug: "squarespace",
    header: "squarespace-signature",
    prefix: "",
    sigEnc: "hex" as const,
    secret: SQSP_HEX_SECRET,
    keyBytes: sqspKey,
  },
  {
    slug: "nylas",
    header: "x-nylas-signature",
    prefix: "",
    sigEnc: "hex" as const,
    secret: UTF8_SECRET,
    keyBytes: utf8Key,
  },
] as const;

describe("S8 Bucket B2 — simple raw-body HMAC", () => {
  for (const { slug, header, prefix, sigEnc, secret, keyBytes } of RAW_BODY) {
    describe(slug, () => {
      it(`exposes ${header} metadata`, () => {
        const a = getAdapterForScheme(slug)!;
        expect(a.scheme).toBe(slug);
        expect(a.signatureHeader).toBe(header);
      });

      it(`verifies a raw-body HMAC-SHA256/${sigEnc}${prefix ? ` (value prefix "${prefix}")` : ""}`, async () => {
        const sig = prefix + enc(await mac("SHA-256", keyBytes, BODY), sigEnc);
        const result = await getAdapterForScheme(slug)!.verify({
          rawBody: utf8Encoder.encode(BODY),
          headers: [[header, sig]],
          secrets: [secret],
          now: NOW,
        });
        expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: slug });
      });

      it("does not verify a tampered body", async () => {
        const sig = prefix + enc(await mac("SHA-256", keyBytes, BODY), sigEnc);
        const result = await getAdapterForScheme(slug)!.verify({
          rawBody: utf8Encoder.encode('{"event":"bucket.b2","id":"evt_TAMPERED"}'),
          headers: [[header, sig]],
          secrets: [secret],
          now: NOW,
        });
        expect(result.ok).toBe(false);
      });
    });
  }
});

// ── framed / literal-prefix HMAC ─────────────────────────────────────────────────────────────────────
describe("S8 Bucket B2 — framed / literal HMAC", () => {
  it('linkedin: HMAC-SHA256/hex over `"hmacsha256=" + body` (literal on the MESSAGE)', async () => {
    const sig = enc(await mac("SHA-256", utf8Key, `hmacsha256=${BODY}`), "hex");
    const result = await getAdapterForScheme("linkedin")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [["x-li-signature", sig]],
      secrets: [UTF8_SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "linkedin" });
  });

  it("linkedin: rejects a signature computed WITHOUT the `hmacsha256=` literal (guards the framing)", async () => {
    const sig = enc(await mac("SHA-256", utf8Key, BODY), "hex"); // over the bare body — wrong
    const result = await getAdapterForScheme("linkedin")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [["x-li-signature", sig]],
      secrets: [UTF8_SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });

  it("airship: HMAC-SHA256/hex over `{ts}:{body}` (x-ua-timestamp header)", async () => {
    const sig = enc(await mac("SHA-256", utf8Key, `${TS}:${BODY}`), "hex");
    const result = await getAdapterForScheme("airship")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [
        ["x-ua-timestamp", String(TS)],
        ["x-ua-signature", sig],
      ],
      secrets: [UTF8_SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "airship" });
  });

  it("lob: HMAC-SHA256/hex over `{ts}.{body}` (lob-signature-timestamp header)", async () => {
    const sig = enc(await mac("SHA-256", utf8Key, `${TS}.${BODY}`), "hex");
    const result = await getAdapterForScheme("lob")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [
        ["lob-signature-timestamp", String(TS)],
        ["lob-signature", sig],
      ],
      secrets: [UTF8_SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "lob" });
  });

  // csvKv Stripe-shaped: `<header>: <tsKey>=<ts>,<sigKey>=<hex>` over `{ts}.{body}`.
  const CSV_KV = [
    { slug: "tiktok", header: "tiktok-signature", tsKey: "t", sigKey: "s" },
    { slug: "persona", header: "persona-signature", tsKey: "t", sigKey: "v1" },
  ] as const;

  for (const { slug, header, tsKey, sigKey } of CSV_KV) {
    it(`${slug}: HMAC-SHA256/hex over \`{ts}.{body}\`, csvKv \`${tsKey}=..,${sigKey}=..\``, async () => {
      const sig = enc(await mac("SHA-256", utf8Key, `${TS}.${BODY}`), "hex");
      const result = await getAdapterForScheme(slug)!.verify({
        rawBody: utf8Encoder.encode(BODY),
        headers: [[header, `${tsKey}=${TS},${sigKey}=${sig}`]],
        secrets: [UTF8_SECRET],
        now: NOW,
      });
      expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: slug });
    });
  }
});
