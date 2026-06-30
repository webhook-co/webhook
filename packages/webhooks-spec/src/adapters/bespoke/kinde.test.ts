import { describe, expect, it } from "vitest";

import type { KeyFetchSpec } from "../../adapter";
import { utf8Encoder } from "../../bytes";
import { getAdapterForScheme } from "../registry";

// Kinde — the body IS an RS256 JWT; the verification key is fetched from the registered issuer's JWKS.
// Self-minted: a fresh RSA keypair → a JWKS (mocked into `fetchKey`), and a JWT signed by it.

const ISSUER = "https://acme.kinde.com";
const KID = "test-kid-1";

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function setup(): Promise<{
  jwksBytes: Uint8Array;
  mint: (payload: Record<string, unknown>, alg?: string) => Promise<string>;
}> {
  const kp = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const jwkForJwks = { ...jwk, kid: KID, use: "sig", alg: "RS256" };
  const jwksBytes = utf8Encoder.encode(JSON.stringify({ keys: [jwkForJwks] }));

  const mint = async (payload: Record<string, unknown>, alg = "RS256"): Promise<string> => {
    const header = b64url(utf8Encoder.encode(JSON.stringify({ alg, typ: "JWT", kid: KID })));
    const body = b64url(utf8Encoder.encode(JSON.stringify(payload)));
    const signingInput = `${header}.${body}`;
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        kp.privateKey,
        utf8Encoder.encode(signingInput),
      ),
    );
    return `${signingInput}.${b64url(sig)}`;
  };
  return { jwksBytes, mint };
}

const payload = {
  iss: ISSUER,
  type: "user.created",
  event_id: "evt_1",
  timestamp: "2026-06-30T00:00:00Z",
};

describe("kinde bespoke (body-is-JWT RS256, JWKS fetch)", () => {
  it("exposes kinde metadata (empty signature header — body is the JWT)", () => {
    const adapter = getAdapterForScheme("kinde")!;
    expect(adapter.scheme).toBe("kinde");
    expect(adapter.signatureHeader).toBe("");
  });

  it("verifies a JWT against the issuer's fetched JWKS", async () => {
    const { jwksBytes, mint } = await setup();
    const token = await mint(payload);
    const fetchKey = async (spec: KeyFetchSpec) => {
      expect(spec.url).toBe(`${ISSUER}/.well-known/jwks.json`);
      expect(spec.allowedHosts).toEqual(["acme.kinde.com"]); // host pinned to the REGISTERED issuer
      return jwksBytes;
    };
    const result = await getAdapterForScheme("kinde")!.verify({
      rawBody: utf8Encoder.encode(token),
      headers: [],
      secrets: [ISSUER],
      fetchKey,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "kinde" });
  });

  it("reports NO_MATCHING_KEY when the token's iss isn't a registered issuer", async () => {
    const { jwksBytes, mint } = await setup();
    const token = await mint(payload);
    const result = await getAdapterForScheme("kinde")!.verify({
      rawBody: utf8Encoder.encode(token),
      headers: [],
      secrets: ["https://other.kinde.com"],
      fetchKey: async () => jwksBytes,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("NO_MATCHING_KEY");
  });

  it("rejects a token whose signature doesn't verify as SIGNATURE_MISMATCH", async () => {
    const { jwksBytes, mint } = await setup();
    const token = await mint(payload);
    // Flip one char of the signature segment — still valid base64url + right length, so the JWT parses
    // (iss matches, kid found) but the signature no longer verifies against the JWKS key.
    const parts = token.split(".");
    const sig = parts[2]!.split("");
    sig[10] = sig[10] === "A" ? "B" : "A";
    const tampered = `${parts[0]}.${parts[1]}.${sig.join("")}`;
    const result = await getAdapterForScheme("kinde")!.verify({
      rawBody: utf8Encoder.encode(tampered),
      headers: [],
      secrets: [ISSUER],
      fetchKey: async () => jwksBytes,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("SIGNATURE_MISMATCH");
  });

  it("fails soft to KEY_FETCH_FAILED when the JWKS can't be fetched", async () => {
    const { mint } = await setup();
    const token = await mint(payload);
    const result = await getAdapterForScheme("kinde")!.verify({
      rawBody: utf8Encoder.encode(token),
      headers: [],
      secrets: [ISSUER],
      fetchKey: async () => null, // fetch failed
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("KEY_FETCH_FAILED");
  });

  it("fails soft to KEY_FETCH_FAILED when no fetcher is available (pure context)", async () => {
    const { mint } = await setup();
    const token = await mint(payload);
    const result = await getAdapterForScheme("kinde")!.verify({
      rawBody: utf8Encoder.encode(token),
      headers: [],
      secrets: [ISSUER],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("KEY_FETCH_FAILED");
  });

  it("rejects a non-RS256 alg as MALFORMED_SIGNATURE", async () => {
    const { jwksBytes, mint } = await setup();
    const token = await mint(payload, "HS256"); // alg the verifier won't honor
    const result = await getAdapterForScheme("kinde")!.verify({
      rawBody: utf8Encoder.encode(token),
      headers: [],
      secrets: [ISSUER],
      fetchKey: async () => jwksBytes,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("rejects a non-JWS body as MALFORMED_SIGNATURE", async () => {
    const { jwksBytes } = await setup();
    const result = await getAdapterForScheme("kinde")!.verify({
      rawBody: utf8Encoder.encode("not-a-jwt"),
      headers: [],
      secrets: [ISSUER],
      fetchKey: async () => jwksBytes,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });
});
