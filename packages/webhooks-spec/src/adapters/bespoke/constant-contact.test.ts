import { describe, expect, it } from "vitest";

import { utf8Encoder } from "../../bytes";
import type { KeyFetcher } from "../../adapter";
import { getAdapterForScheme } from "../registry";

// Constant Contact V3 webhooks — a DETACHED (RFC 7797) RS256 JWS in `X-CTCT-WEBHOOK-SIG`:
// `<b64url(header)>..<b64url(sig)>` (empty payload segment), header `{alg:"RS256",ts,b64:false,crit:["b64"]}`,
// signing input `ASCII(b64url(header)) + "." + rawBody`. The key comes from Constant Contact's PUBLIC JWKS
// (developer.constantcontact.com), which carries NO kid → try every RSA key. The registered secret is only
// an enable-marker (CC signs with its own account key; there is no per-endpoint secret). No public gold
// vector exists, so we self-generate an RSA keypair + JWKS and sign a real detached JWS — a true
// cross-check of the detached-JWS reconstruction + RFC-7797 signing input + RS256 verify. Like eBay, this
// is unit-verified but NOT yet validated against a live Constant Contact webhook (needs a real CC account).

function bytesToB64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64urlStr = (s: string): string => bytesToB64url(utf8Encoder.encode(s));

const BODY = utf8Encoder.encode('{"event":"contact.created","id":"c_1"}');
const TS = 1_603_992_205; // the `ts` baked into the default signed header
const NOW = new Date(TS * 1000 + 1000); // within the replay window of the signed ts

async function genRsa(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

async function jwksFor(kp: CryptoKeyPair, use = "sig"): Promise<string> {
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  return JSON.stringify({ keys: [{ ...jwk, use, kid: "cc-1" }] });
}

/** Build a detached RFC-7797 JWS over `body`, signed with `kp`'s private key. */
async function signDetached(
  kp: CryptoKeyPair,
  body: Uint8Array,
  header: Record<string, unknown> = { alg: "RS256", ts: 1_603_992_205, b64: false, crit: ["b64"] },
): Promise<string> {
  const headerB64 = b64urlStr(JSON.stringify(header));
  const signingInput = new Uint8Array([...utf8Encoder.encode(`${headerB64}.`), ...body]);
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, signingInput),
  );
  return `${headerB64}..${bytesToB64url(sig)}`;
}

/** A fetchKey that always returns the given JWKS bytes (and asserts the host pin). */
const fetchKeyReturning = (jwks: string): KeyFetcher => {
  return async (spec) => {
    expect(spec.url).toContain("developer.constantcontact.com");
    return utf8Encoder.encode(jwks);
  };
};

const headers = (sig: string): ReadonlyArray<readonly [string, string]> => [
  ["content-type", "application/json"],
  ["x-ctct-webhook-sig", sig],
];

describe("constant_contact bespoke (detached RS256 JWS + JWKS)", () => {
  it("exposes constant_contact metadata", () => {
    const a = getAdapterForScheme("constant_contact")!;
    expect(a.scheme).toBe("constant_contact");
    expect(a.signatureHeader).toBe("x-ctct-webhook-sig");
  });

  it("verifies a valid detached RS256 JWS against the JWKS", async () => {
    const kp = await genRsa();
    const sig = await signDetached(kp, BODY);
    const result = await getAdapterForScheme("constant_contact")!.verify({
      rawBody: BODY,
      headers: headers(sig),
      secrets: ["enabled"], // enable-marker
      fetchKey: fetchKeyReturning(await jwksFor(kp)),
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "constant_contact" });
  });

  it("rejects a validly-signed but STALE ts as TIMESTAMP_TOO_OLD (replay window)", async () => {
    const kp = await genRsa();
    const sig = await signDetached(kp, BODY); // ts baked in is 2020
    const result = await getAdapterForScheme("constant_contact")!.verify({
      rawBody: BODY,
      headers: headers(sig),
      secrets: ["enabled"],
      fetchKey: fetchKeyReturning(await jwksFor(kp)),
      now: new Date(TS * 1000 + 10 * 60 * 1000), // 10 min after ts, well outside the 300s window
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("TIMESTAMP_TOO_OLD");
  });

  it("rejects a tampered body (signing input no longer matches)", async () => {
    const kp = await genRsa();
    const sig = await signDetached(kp, BODY);
    const result = await getAdapterForScheme("constant_contact")!.verify({
      rawBody: utf8Encoder.encode('{"event":"contact.created","id":"c_TAMPERED"}'),
      headers: headers(sig),
      secrets: ["enabled"],
      fetchKey: fetchKeyReturning(await jwksFor(kp)),
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a signature whose key is NOT in the JWKS (different keypair)", async () => {
    const signer = await genRsa();
    const other = await genRsa(); // JWKS carries a different key
    const sig = await signDetached(signer, BODY);
    const result = await getAdapterForScheme("constant_contact")!.verify({
      rawBody: BODY,
      headers: headers(sig),
      secrets: ["enabled"],
      fetchKey: fetchKeyReturning(await jwksFor(other)),
    });
    expect(result.ok).toBe(false);
  });

  it("reports MALFORMED when the payload segment is NOT empty (a normal, non-detached JWS)", async () => {
    const kp = await genRsa();
    const headerB64 = b64urlStr(JSON.stringify({ alg: "RS256", b64: false, crit: ["b64"] }));
    const result = await getAdapterForScheme("constant_contact")!.verify({
      rawBody: BODY,
      headers: headers(`${headerB64}.${b64urlStr("payload")}.${b64urlStr("sig")}`),
      secrets: ["enabled"],
      fetchKey: fetchKeyReturning(await jwksFor(kp)),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("reports MALFORMED when b64 is not false (a non-RFC-7797 header)", async () => {
    const kp = await genRsa();
    const sig = await signDetached(kp, BODY, { alg: "RS256", b64: true, crit: ["b64"] });
    const result = await getAdapterForScheme("constant_contact")!.verify({
      rawBody: BODY,
      headers: headers(sig),
      secrets: ["enabled"],
      fetchKey: fetchKeyReturning(await jwksFor(kp)),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("reports MALFORMED for a non-RS256 algorithm", async () => {
    const kp = await genRsa();
    const sig = await signDetached(kp, BODY, { alg: "HS256", b64: false, crit: ["b64"] });
    const result = await getAdapterForScheme("constant_contact")!.verify({
      rawBody: BODY,
      headers: headers(sig),
      secrets: ["enabled"],
      fetchKey: fetchKeyReturning(await jwksFor(kp)),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("reports MISSING_HEADER when x-ctct-webhook-sig is absent", async () => {
    const result = await getAdapterForScheme("constant_contact")!.verify({
      rawBody: BODY,
      headers: [["content-type", "application/json"]],
      secrets: ["enabled"],
      fetchKey: fetchKeyReturning('{"keys":[]}'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MISSING_HEADER");
  });

  it("reports KEY_FETCH_FAILED when the JWKS fetch yields nothing", async () => {
    const kp = await genRsa();
    const sig = await signDetached(kp, BODY);
    const result = await getAdapterForScheme("constant_contact")!.verify({
      rawBody: BODY,
      headers: headers(sig),
      secrets: ["enabled"],
      fetchKey: async () => null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("KEY_FETCH_FAILED");
  });
});
