import { describe, expect, it } from "vitest";

import { importHmacKeyForHash, utf8Encoder } from "../../bytes";
import { getAdapterForScheme } from "../registry";

// Monday.com webhooks — a BARE HS256 JWT in the `Authorization` header (no `Bearer ` prefix). The token
// authenticates origin + account + destination via signed claims (`aud` = the exact endpoint URL, plus
// accountId/userId/iat/exp) but carries NO body-hash claim, so it is ORIGIN-authenticated, not body-
// integrity-bound (documented). Key = the app Signing Secret verbatim utf8. We verify the JWS, bind `aud`
// to the request URL, and enforce exp/iat freshness. No published vector → self-minted KAT.
//
// (Webhooks created via the UI / a personal-token GraphQL call are UNSIGNED — no Authorization header —
// and are simply unverifiable; only monday-app/OAuth-created webhooks carry the JWT.)

const SECRET = "monday-app-signing-secret";
const HEADER = "authorization";
const AUD = "https://wbhk.my/whep_monday";
// iat 1789999900 / exp 1790000200 → inject a `now` inside the window.
const NOW = new Date(1790000000 * 1000);

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
async function mondayToken(secret: string, aud = AUD): Promise<string> {
  return mintHs256(secret, { accountId: 123, userId: 456, aud, iat: 1789999900, exp: 1790000200 });
}

const BODY = '{"event":{"type":"create_pulse"}}';

function input(token: string, overrides: Record<string, unknown> = {}) {
  return {
    rawBody: utf8Encoder.encode(BODY),
    headers: [[HEADER, token]] as [string, string][],
    secrets: [SECRET],
    requestUrl: AUD,
    method: "POST",
    now: NOW,
    ...overrides,
  };
}

describe("monday bespoke (bare HS256 JWT, aud-bound, origin-auth)", () => {
  it("exposes monday metadata", () => {
    const adapter = getAdapterForScheme("monday")!;
    expect(adapter.scheme).toBe("monday");
    expect(adapter.signatureHeader).toBe(HEADER);
  });

  it("verifies a bare JWT whose aud matches the request URL", async () => {
    const result = await getAdapterForScheme("monday")!.verify(input(await mondayToken(SECRET)));
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "monday" });
  });

  it("rejects a wrong signing secret with WRONG_SECRET", async () => {
    const result = await getAdapterForScheme("monday")!.verify(
      input(await mondayToken("attacker")),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("WRONG_SECRET");
  });

  it("rejects a token whose aud is a different endpoint as SIGNATURE_MISMATCH", async () => {
    const token = await mondayToken(SECRET, "https://evil.example/whep_x");
    const result = await getAdapterForScheme("monday")!.verify(input(token));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("SIGNATURE_MISMATCH");
  });

  it("rejects a token with no aud claim (aud required) as SIGNATURE_MISMATCH", async () => {
    const token = await mintHs256(SECRET, { accountId: 1, iat: 1789999900, exp: 1790000200 }); // no aud
    const result = await getAdapterForScheme("monday")!.verify(input(token));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("SIGNATURE_MISMATCH");
  });

  it("rejects an expired token (now past exp + tolerance) as TIMESTAMP_TOO_OLD", async () => {
    const result = await getAdapterForScheme("monday")!.verify(
      input(await mondayToken(SECRET), { now: new Date(1790001000 * 1000) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("TIMESTAMP_TOO_OLD");
  });

  it("reports MISSING_HEADER when Authorization is absent", async () => {
    const result = await getAdapterForScheme("monday")!.verify(input("x", { headers: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MISSING_HEADER");
  });
});
