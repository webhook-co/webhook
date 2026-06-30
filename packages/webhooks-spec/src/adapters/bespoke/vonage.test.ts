import { describe, expect, it } from "vitest";

import { bytesToHex, importHmacKeyForHash, sha256, utf8Encoder } from "../../bytes";
import { getAdapterForScheme } from "../registry";

// Vonage / Nexmo signed webhooks (Messages/Dispatch/Verify/Voice) — `Authorization: Bearer <jwt>` is an
// HS256 JWT with `iss: "Vonage"` and `payload_hash` = hex SHA-256 of the raw body (plus iat/jti/api_key,
// no nbf/exp). Key = the account Signature Secret verbatim utf8. We verify the JWS, check iss, then
// recompute SHA-256(body) and compare. No published numeric vector → self-minted KAT.

const SECRET = "vonage-signature-secret";
const HEADER = "authorization";
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

const BODY = '{"message_uuid":"aaa","from":"447700900000"}';

async function vonageBearer(secret: string, body: string, iss = "Vonage"): Promise<string> {
  const token = await mintHs256(secret, {
    iss,
    iat: 1790000000,
    jti: "a-uuid",
    payload_hash: await sha256Hex(body),
    api_key: "abcd1234",
  });
  return `Bearer ${token}`;
}

describe("vonage bespoke (Bearer HS256 JWT + payload_hash body binding)", () => {
  it("exposes vonage metadata", () => {
    const adapter = getAdapterForScheme("vonage")!;
    expect(adapter.scheme).toBe("vonage");
    expect(adapter.signatureHeader).toBe(HEADER);
  });

  it("verifies a Bearer token whose payload_hash matches the body", async () => {
    const result = await getAdapterForScheme("vonage")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [[HEADER, await vonageBearer(SECRET, BODY)]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "vonage" });
  });

  it("rejects a wrong signature secret with WRONG_SECRET", async () => {
    const result = await getAdapterForScheme("vonage")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [[HEADER, await vonageBearer("attacker", BODY)]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("WRONG_SECRET");
  });

  it("rejects a mutated body (payload_hash no longer matches) as PROXY_MUTATED_BYTES", async () => {
    const result = await getAdapterForScheme("vonage")!.verify({
      rawBody: utf8Encoder.encode('{"message_uuid":"bbb"}'),
      headers: [[HEADER, await vonageBearer(SECRET, BODY)]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("PROXY_MUTATED_BYTES");
  });

  it("rejects the wrong issuer as SIGNATURE_MISMATCH", async () => {
    const result = await getAdapterForScheme("vonage")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [[HEADER, await vonageBearer(SECRET, BODY, "NotVonage")]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("SIGNATURE_MISMATCH");
  });

  it("reports MISSING_HEADER when Authorization is absent", async () => {
    const result = await getAdapterForScheme("vonage")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MISSING_HEADER");
  });
});
