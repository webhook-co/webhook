import { describe, expect, it } from "vitest";

import { b64ToBytes, hmacSha256, utf8Encoder } from "../bytes";
import { getAdapterForScheme } from "./registry";
import { isUsableStandardWebhooksSecret } from "./shared";

// The Standard-Webhooks (Svix) aliases (W0): clerk/resend/stytch emit Svix's original `svix-*`
// header trio; supabase/render/brex use the standardized `webhook-*` names. All share the SW crypto
// (already exhaustively covered by standard-webhooks.test.ts), so these tests prove each alias reads
// the RIGHT header trio and is wired into the registry — a self-consistent KAT per provider.

// base64-encode bytes (standard alphabet, padded). Test-local: production only needs DECODE.
function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// Sign per the Standard Webhooks v1 construction: key = base64-decode(secret minus `whsec_`);
// message = `{id}.{ts}.{body}`; MAC = base64(HMAC-SHA256). Returns a `v1,<b64>` entry.
async function signSW(id: string, ts: number, body: string, secret: string): Promise<string> {
  // Mirror the adapter's key normalization: strip an optional `v1,` version tag (Supabase) then an
  // optional `whsec_` prefix, leaving the base64 key material.
  const key = b64ToBytes(secret.replace(/^v\d+,/, "").replace(/^whsec_/, ""));
  if (key === null) throw new Error("test secret is not valid base64");
  const mac = await hmacSha256(key, utf8Encoder.encode(`${id}.${ts}.${body}`));
  return `v1,${bytesToB64(mac)}`;
}

const SECRET = `whsec_${bytesToB64(utf8Encoder.encode("a-standard-webhooks-secret-32byte"))}`;
const ID = "msg_2KWPBgLlAfxdpx2AI54pPJ85f4W";
const BODY = '{"event":"user.created","id":"u_1"}';
const TS = 1_790_000_000;

/** slug -> the header-name prefix it signs with. */
const ALIASES = [
  ["clerk", "svix"],
  ["resend", "svix"],
  ["stytch", "svix"],
  ["supabase", "webhook"],
  ["render", "webhook"],
  ["brex", "webhook"],
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

describe("Standard Webhooks (Svix) aliases", () => {
  for (const [slug, prefix] of ALIASES) {
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

  // The two non-standard secret SHAPES these providers ship (beyond plain `whsec_<base64>`).
  describe("secret formats", () => {
    it("verifies + accepts Supabase's `v1,whsec_<base64>` secret form", async () => {
      const supabaseSecret = `v1,${SECRET}`; // SECRET is `whsec_<base64>` → `v1,whsec_<base64>`
      expect(isUsableStandardWebhooksSecret(supabaseSecret)).toBe(true);
      const sig = await signSW(ID, TS, BODY, supabaseSecret);
      const result = await getAdapterForScheme("supabase")!.verify({
        rawBody: utf8Encoder.encode(BODY),
        headers: headers("webhook", sig),
        secrets: [supabaseSecret],
        now: new Date(TS * 1000 + 1000),
      });
      expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "supabase" });
    });

    it("verifies + accepts Brex's bare-base64 secret form (no whsec_ prefix)", async () => {
      const brexSecret = bytesToB64(utf8Encoder.encode("a-brex-bare-base64-secret-32byte"));
      expect(isUsableStandardWebhooksSecret(brexSecret)).toBe(true);
      const sig = await signSW(ID, TS, BODY, brexSecret);
      const result = await getAdapterForScheme("brex")!.verify({
        rawBody: utf8Encoder.encode(BODY),
        headers: headers("webhook", sig),
        secrets: [brexSecret],
        now: new Date(TS * 1000 + 1000),
      });
      expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "brex" });
    });

    it("rejects a non-base64 secret at registration (any garbage paste)", () => {
      expect(isUsableStandardWebhooksSecret("not valid base64 !!!")).toBe(false);
    });
  });
});
