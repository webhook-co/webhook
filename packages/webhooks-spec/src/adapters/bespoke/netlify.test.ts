import { describe, expect, it } from "vitest";

import { bytesToHex, importHmacKeyForHash, sha256, utf8Encoder } from "../../bytes";
import { getAdapterForScheme } from "../registry";

// Netlify deploy webhooks — `X-Webhook-Signature` carries an HS256 compact JWS whose payload is exactly
// `{ iss: "netlify", sha256: <hex SHA-256 of the raw body> }` (no iat/exp → no replay window). We verify
// the JWS (key = the configured "JWS secret token" verbatim utf8), check iss, then recompute SHA-256 of
// the body and compare. No published numeric vector → self-minted KAT.

const SECRET = "netlify-jws-secret-token";
const HEADER = "x-webhook-signature";
const NOW = new Date("2026-06-30T00:00:00Z");

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function mintHs256(secret: string, payload: Record<string, unknown>): Promise<string> {
  const header = b64url(utf8Encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(utf8Encoder.encode(JSON.stringify(payload)));
  const signingInput = `${header}.${body}`;
  const key = await importHmacKeyForHash(utf8Encoder.encode(secret), "SHA-256");
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, utf8Encoder.encode(signingInput)),
  );
  return `${signingInput}.${b64url(mac)}`;
}
async function sha256Hex(s: string): Promise<string> {
  return bytesToHex(await sha256(utf8Encoder.encode(s)));
}

const BODY = '{"state":"ready","id":"deploy_1"}';

async function netlifyToken(secret: string, body: string, iss = "netlify"): Promise<string> {
  return mintHs256(secret, { iss, sha256: await sha256Hex(body) });
}

describe("netlify bespoke (HS256 JWS + sha256 body-hash claim)", () => {
  it("exposes netlify metadata", () => {
    const adapter = getAdapterForScheme("netlify")!;
    expect(adapter.scheme).toBe("netlify");
    expect(adapter.signatureHeader).toBe(HEADER);
  });

  it("verifies a token whose sha256 claim matches the body", async () => {
    const token = await netlifyToken(SECRET, BODY);
    const result = await getAdapterForScheme("netlify")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [[HEADER, token]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "netlify" });
  });

  it("rejects a wrong secret with WRONG_SECRET", async () => {
    const token = await netlifyToken("attacker", BODY);
    const result = await getAdapterForScheme("netlify")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [[HEADER, token]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("WRONG_SECRET");
  });

  it("rejects a body that doesn't match the signed sha256 claim as PROXY_MUTATED_BYTES", async () => {
    const token = await netlifyToken(SECRET, BODY);
    const result = await getAdapterForScheme("netlify")!.verify({
      rawBody: utf8Encoder.encode('{"state":"error"}'), // body changed after signing
      headers: [[HEADER, token]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("PROXY_MUTATED_BYTES");
  });

  it("rejects a token with the wrong issuer as SIGNATURE_MISMATCH", async () => {
    const token = await netlifyToken(SECRET, BODY, "evil");
    const result = await getAdapterForScheme("netlify")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [[HEADER, token]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("SIGNATURE_MISMATCH");
  });

  it("rejects a token missing the iss claim (iss required) as SIGNATURE_MISMATCH", async () => {
    const token = await mintHs256(SECRET, { sha256: await sha256Hex(BODY) }); // valid sig, no iss
    const result = await getAdapterForScheme("netlify")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [[HEADER, token]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("SIGNATURE_MISMATCH");
  });

  it("reports MISSING_HEADER when the signature header is absent", async () => {
    const result = await getAdapterForScheme("netlify")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MISSING_HEADER");
  });
});
