import { describe, expect, it } from "vitest";

import { bytesToHex, hexToBytes, utf8Encoder } from "../bytes";
import { getAdapterForScheme } from "./registry";

// S8 coverage PR3 — "Bucket B" quirk-HMAC providers. Every one fits the config-driven factory (no
// bespoke code); these self-consistent KATs sign exactly the way each provider's docs specify and
// assert the config-driven adapter verifies. Schemes doc-verified per provider (research 2026-07-01):
//   simple raw-body : xero (sha256/b64) · segment (SHA1/hex) · aftership (sha256/b64)
//                     · onfleet (SHA512/hex, HEX-DECODED key)
//   timestamp-framed: webflow (`{ts}:{body}`) · klaviyo (`{body}{ts}` body-first) · mux/shippo/buildkite
//                     (csvKv `t=..,v1=..` over `{ts}.{body}`)
// Deferred (need a schema knob, not a config row): box (dual primary/secondary header+secret),
// configcat (rotation sends comma-joined digests); pipedrive is Basic-Auth (no signature) — all excluded.

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
const encode = (b: Uint8Array, fmt: "hex" | "base64"): string =>
  fmt === "hex" ? bytesToHex(b) : bytesToB64(b);

const SECRET = "an-s8-bucket-b-signing-secret"; // gitleaks:allow — fabricated test fixture
const utf8Key = utf8Encoder.encode(SECRET);
const BODY = '{"event":"bucket.b","id":"evt_bb"}';
const TS = 1_790_000_000;
const NOW = new Date(TS * 1000 + 1000); // within the replay window of the signed timestamp

// ── simple raw-body HMAC (signature over the exact body) ───────────────────────────────────────────
const RAW_BODY = [
  {
    slug: "xero",
    header: "x-xero-signature",
    hash: "SHA-256",
    enc: "base64" as const,
    hexKey: false,
  },
  { slug: "segment", header: "x-signature", hash: "SHA-1", enc: "hex" as const, hexKey: false },
  {
    slug: "aftership",
    header: "aftership-hmac-sha256",
    hash: "SHA-256",
    enc: "base64" as const,
    hexKey: false,
  },
  // Onfleet: SHA-512, hex signature, and the secret is a HEX string decoded to the HMAC key bytes.
  {
    slug: "onfleet",
    header: "x-onfleet-signature",
    hash: "SHA-512",
    enc: "hex" as const,
    hexKey: true,
  },
] as const;

// A valid hex secret for Onfleet's hex-decoded key derivation (fabricated fixture, not a credential).
const ONFLEET_HEX_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef"; // gitleaks:allow — fake test fixture

describe("S8 Bucket B — simple raw-body HMAC", () => {
  for (const { slug, header, hash, enc, hexKey } of RAW_BODY) {
    describe(slug, () => {
      const secretStr = hexKey ? ONFLEET_HEX_SECRET : SECRET;
      const keyBytes = hexKey ? hexToBytes(ONFLEET_HEX_SECRET)! : utf8Key;

      it(`exposes ${header} metadata`, () => {
        const a = getAdapterForScheme(slug)!;
        expect(a.scheme).toBe(slug);
        expect(a.signatureHeader).toBe(header);
      });

      it(`verifies a ${hash}/${enc} HMAC over the raw body${hexKey ? " (hex-decoded key)" : ""}`, async () => {
        const sig = encode(await mac(hash, keyBytes, BODY), enc);
        const result = await getAdapterForScheme(slug)!.verify({
          rawBody: utf8Encoder.encode(BODY),
          headers: [[header, sig]],
          secrets: [secretStr],
          now: NOW,
        });
        expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: slug });
      });

      it("does not verify a tampered body", async () => {
        const sig = encode(await mac(hash, keyBytes, BODY), enc);
        const result = await getAdapterForScheme(slug)!.verify({
          rawBody: utf8Encoder.encode('{"event":"bucket.b","id":"evt_TAMPERED"}'),
          headers: [[header, sig]],
          secrets: [secretStr],
          now: NOW,
        });
        expect(result.ok).toBe(false);
      });
    });
  }
});

// ── timestamp-framed HMAC ──────────────────────────────────────────────────────────────────────────
describe("S8 Bucket B — timestamp-framed HMAC", () => {
  it("webflow: HMAC-SHA256/hex over `{timestamp}:{body}` (x-webflow-timestamp header)", async () => {
    const sig = encode(await mac("SHA-256", utf8Key, `${TS}:${BODY}`), "hex");
    const result = await getAdapterForScheme("webflow")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [
        ["x-webflow-timestamp", String(TS)],
        ["x-webflow-signature", sig],
      ],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "webflow" });
  });

  it("klaviyo: HMAC-SHA256/hex over `{body}{timestamp}` — body FIRST, no separator", async () => {
    const sig = encode(await mac("SHA-256", utf8Key, `${BODY}${TS}`), "hex");
    const result = await getAdapterForScheme("klaviyo")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [
        ["klaviyo-timestamp", String(TS)],
        ["klaviyo-signature", sig],
      ],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "klaviyo" });
  });

  // Stripe-shaped: `<sigHeader>: <tsKey>=<ts>,<sigKey>=<hex>` over `{ts}.{body}`.
  const CSV_KV = [
    { slug: "mux", header: "mux-signature", tsKey: "t", sigKey: "v1" },
    { slug: "shippo", header: "shippo-auth-signature", tsKey: "t", sigKey: "v1" },
    { slug: "buildkite", header: "x-buildkite-signature", tsKey: "timestamp", sigKey: "signature" },
  ] as const;

  for (const { slug, header, tsKey, sigKey } of CSV_KV) {
    it(`${slug}: HMAC-SHA256/hex over \`{ts}.{body}\`, csvKv \`${tsKey}=..,${sigKey}=..\``, async () => {
      const sig = encode(await mac("SHA-256", utf8Key, `${TS}.${BODY}`), "hex");
      const result = await getAdapterForScheme(slug)!.verify({
        rawBody: utf8Encoder.encode(BODY),
        headers: [[header, `${tsKey}=${TS},${sigKey}=${sig}`]],
        secrets: [SECRET],
        now: NOW,
      });
      expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: slug });
    });

    it(`${slug}: rejects a tampered body`, async () => {
      const sig = encode(await mac("SHA-256", utf8Key, `${TS}.${BODY}`), "hex");
      const result = await getAdapterForScheme(slug)!.verify({
        rawBody: utf8Encoder.encode('{"event":"bucket.b","id":"evt_TAMPERED"}'),
        headers: [[header, `${tsKey}=${TS},${sigKey}=${sig}`]],
        secrets: [SECRET],
        now: NOW,
      });
      expect(result.ok).toBe(false);
    });
  }
});
