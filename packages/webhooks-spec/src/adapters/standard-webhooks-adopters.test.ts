import { describe, expect, it } from "vitest";

import { b64ToBytes, hmacSha256, utf8Encoder } from "../bytes";
import { SW_SECRET_PROVIDERS } from "./config";
import { getAdapterForScheme } from "./registry";

// S8 coverage batch — providers that verify webhooks with the Standard Webhooks construction we
// already ship (HMAC-SHA256 over `{id}.{ts}.{body}`, base64, `v1,<sig>` list), differing only in the
// header-name prefix. Each is a one-line `standardWebhooksConfig` config row; these KATs prove each
// reads the RIGHT header trio and is wired into the registry (the SW crypto itself is exhaustively
// covered by standard-webhooks.test.ts). Schemes doc-verified per provider (research 2026-07-01):
//   webhook-* (spec-native): OpenAI, Replicate, Polar, Gemini (static mode), incident.io, Etsy
//   svix-*    (Svix legacy) : Vanta
// Anthropic (custom `X-Webhook-Signature`), Gemini dynamic-mode (JWT/RS256), Kong (Ed25519-in-body),
// Drata/TaskRabbit (Svix confirmed but wire prefix NOT doc-confirmed) and Beehiiv (unsigned) are
// deliberately NOT here — a guessed scheme would silently mis-verify.

// base64-encode bytes (standard alphabet, padded). Test-local: production only needs DECODE.
function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// Sign per the Standard Webhooks v1 construction: key = base64-decode(secret minus `whsec_`);
// message = `{id}.{ts}.{body}`; MAC = base64(HMAC-SHA256). Returns a `v1,<b64>` entry.
async function signSW(id: string, ts: number, body: string, secret: string): Promise<string> {
  const key = b64ToBytes(secret.replace(/^whsec_/, ""));
  if (key === null) throw new Error("test secret is not valid base64");
  const mac = await hmacSha256(key, utf8Encoder.encode(`${id}.${ts}.${body}`));
  return `v1,${bytesToB64(mac)}`;
}

const SECRET = `whsec_${bytesToB64(utf8Encoder.encode("a-standard-webhooks-secret-32byte"))}`;
const ID = "msg_2KWPBgLlAfxdpx2AI54pPJ85f4W";
const BODY = '{"event":"order.created","id":"ord_1"}';
const TS = 1_790_000_000;

/**
 * slug -> the header-name prefix it signs with (doc-verified per provider). These use the SW
 * `whsec_`-base64 key derivation. Polar is NOT here — it uses the SAME SW message framing but a
 * raw-UTF-8 key (its own dedicated block below), so it can't share the `whsec_` fixture.
 */
const ADOPTERS = [
  ["openai", "webhook"],
  ["replicate", "webhook"],
  ["gemini", "webhook"],
  ["incident_io", "webhook"],
  ["etsy", "webhook"],
  ["vanta", "svix"],
] as const;

function headers(
  prefix: string,
  sig: string,
  id: string = ID,
  ts: string = String(TS),
): ReadonlyArray<readonly [string, string]> {
  return [
    ["content-type", "application/json"],
    [`${prefix}-id`, id],
    [`${prefix}-timestamp`, ts],
    [`${prefix}-signature`, sig],
  ];
}

describe("Standard Webhooks adopters (S8 coverage)", () => {
  for (const [slug, prefix] of ADOPTERS) {
    describe(slug, () => {
      it(`exposes ${prefix}-signature metadata`, () => {
        const adapter = getAdapterForScheme(slug)!;
        expect(adapter.scheme).toBe(slug);
        expect(adapter.signatureHeader).toBe(`${prefix}-signature`);
        expect(adapter.toleranceSeconds).toBe(300);
      });

      it(`verifies a Standard-Webhooks signature over the ${prefix}-* header trio`, async () => {
        const sig = await signSW(ID, TS, BODY, SECRET);
        const adapter = getAdapterForScheme(slug)!;
        const result = await adapter.verify({
          rawBody: utf8Encoder.encode(BODY),
          headers: headers(prefix, sig),
          secrets: [SECRET],
          now: new Date(TS * 1000 + 1000), // within tolerance of the signed timestamp
        });
        expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: slug });
      });

      it(`rejects a tampered body under the ${prefix}-* header trio`, async () => {
        const sig = await signSW(ID, TS, BODY, SECRET); // signature is over BODY
        const adapter = getAdapterForScheme(slug)!;
        const result = await adapter.verify({
          rawBody: utf8Encoder.encode('{"event":"order.created","id":"ord_TAMPERED"}'),
          headers: headers(prefix, sig),
          secrets: [SECRET],
          now: new Date(TS * 1000 + 1000),
        });
        expect(result.ok).toBe(false);
      });

      it(`reports MISSING_HEADER when the ${prefix}-signature header is absent`, async () => {
        const adapter = getAdapterForScheme(slug)!;
        const result = await adapter.verify({
          rawBody: utf8Encoder.encode(BODY),
          headers: [["content-type", "application/json"]],
          secrets: [SECRET],
          now: new Date(TS * 1000 + 1000),
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason.code).toBe("MISSING_HEADER");
      });
    });
  }

  // Polar: same SW message framing + `webhook-*` trio, but the HMAC key is the RAW UTF-8 bytes of the
  // whole dashboard secret (a `polar_whs_…` string), NOT a base64/`whsec_`-decoded key. Polar's SDK
  // base64-ENCODES the raw secret before handing it to the standardwebhooks signer (which base64-DECODES
  // it), so the net key is the untouched secret bytes. Routing it to `whsec-base64` would reject the
  // `polar_whs_` secret at registration (underscores aren't base64) and never verify. So Polar uses
  // `keyDerivation: "utf8"` — and must be tested with a real Polar-style secret, not the shared fixture.
  describe("polar (raw-utf8 key)", () => {
    // A realistic Polar secret SHAPE: `polar_whs_` prefix + opaque tail (underscores → NOT valid
    // base64). A fabricated TEST fixture — not a live credential.
    const POLAR_SECRET = "polar_whs_9fK3mQ7pR2sT8vX1yZ4bN6cD0eG5hJ7k"; // gitleaks:allow — fake test fixture
    // Sign the SW message with key = raw UTF-8 bytes of the FULL secret string (prefix included).
    const signPolar = async (id: string, ts: number, body: string): Promise<string> => {
      const mac = await hmacSha256(
        utf8Encoder.encode(POLAR_SECRET),
        utf8Encoder.encode(`${id}.${ts}.${body}`),
      );
      return `v1,${bytesToB64(mac)}`;
    };

    it("is NOT in SW_SECRET_PROVIDERS (its `polar_whs_` secret bypasses the base64-shape refine)", () => {
      // The base64 refine in the contract only applies to SW_SECRET_PROVIDERS; a raw-utf8 provider must
      // be excluded so a legit `polar_whs_…` secret (underscores, not base64) isn't rejected at registration.
      expect(SW_SECRET_PROVIDERS.has("polar")).toBe(false);
    });

    it("exposes webhook-signature metadata", () => {
      const adapter = getAdapterForScheme("polar")!;
      expect(adapter.scheme).toBe("polar");
      expect(adapter.signatureHeader).toBe("webhook-signature");
      expect(adapter.toleranceSeconds).toBe(300);
    });

    it("verifies a Standard-Webhooks signature whose key is the raw `polar_whs_` secret", async () => {
      const sig = await signPolar(ID, TS, BODY);
      const result = await getAdapterForScheme("polar")!.verify({
        rawBody: utf8Encoder.encode(BODY),
        headers: headers("webhook", sig),
        secrets: [POLAR_SECRET],
        now: new Date(TS * 1000 + 1000),
      });
      expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "polar" });
    });

    it("rejects a tampered body", async () => {
      const sig = await signPolar(ID, TS, BODY);
      const result = await getAdapterForScheme("polar")!.verify({
        rawBody: utf8Encoder.encode('{"event":"order.created","id":"ord_TAMPERED"}'),
        headers: headers("webhook", sig),
        secrets: [POLAR_SECRET],
        now: new Date(TS * 1000 + 1000),
      });
      expect(result.ok).toBe(false);
    });

    it("does NOT verify when the key is treated as base64 (guards against a whsec-base64 regression)", async () => {
      // If Polar were (wrongly) routed to whsec-base64, the key would be base64-decode(secret) ≠ the raw
      // bytes, so this correctly-signed (raw-key) request would fail. This pins the utf8 derivation.
      const sig = await signPolar(ID, TS, BODY);
      const b64Key = b64ToBytes(POLAR_SECRET.replace(/^whsec_/, ""));
      // Sanity: the `polar_whs_` secret isn't even valid base64, so the whsec path can't derive a key.
      expect(b64Key).toBeNull();
      const result = await getAdapterForScheme("polar")!.verify({
        rawBody: utf8Encoder.encode(BODY),
        headers: headers("webhook", sig),
        secrets: [POLAR_SECRET],
        now: new Date(TS * 1000 + 1000),
      });
      expect(result.ok).toBe(true); // utf8 path DOES verify — proving we're not on the whsec path
    });

    it("reports MISSING_HEADER when the webhook-signature header is absent", async () => {
      const result = await getAdapterForScheme("polar")!.verify({
        rawBody: utf8Encoder.encode(BODY),
        headers: [["content-type", "application/json"]],
        secrets: [POLAR_SECRET],
        now: new Date(TS * 1000 + 1000),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.code).toBe("MISSING_HEADER");
    });
  });
});
