import { describe, expect, it } from "vitest";

import { bytesToB64, utf8Encoder } from "../../bytes";
import { getAdapterForScheme } from "../registry";

// Keygen webhook signatures (Ed25519 over an HTTP Message Signatures / draft-cavage signing string).
// `Keygen-Signature: keyid="…",algorithm="ed25519",signature="<b64>",headers="(request-target) host date
// digest"`. The signing string is `(request-target): <method> <path>\nhost: <host>\ndate: <date>\ndigest:
// sha-256=<base64(sha256(rawBody))>`. The registered secret is the account's Ed25519 public key (hex). We
// self-generate a keypair and sign a real signing string (no public gold vector exists) — a true
// cross-check of the string reconstruction + digest binding + Ed25519 verify.

const METHOD = "POST";
const PATH = "/whep_keygen_tok";
const HOST = "wbhk.my";
const DATE = "Wed, 09 Jun 2021 16:08:15 GMT";
const URL_STR = `https://wbhk.my${PATH}`;
const BODY = utf8Encoder.encode('{"data":{"type":"webhook-events","id":"evt_1"}}');

async function genKeypair(): Promise<{ kp: CryptoKeyPair; pubHex: string }> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const pubHex = [...pubRaw].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { kp, pubHex };
}

async function sha256B64(body: Uint8Array): Promise<string> {
  return bytesToB64(new Uint8Array(await crypto.subtle.digest("SHA-256", body)));
}

/** Build the exact draft-cavage signing string Keygen signs, and sign it with the private key. */
async function signKeygen(
  kp: CryptoKeyPair,
  body: Uint8Array,
): Promise<{ sigB64: string; digest: string }> {
  const digest = `sha-256=${await sha256B64(body)}`;
  const signingString = [
    `(request-target): ${METHOD.toLowerCase()} ${PATH}`,
    `host: ${HOST}`,
    `date: ${DATE}`,
    `digest: ${digest}`,
  ].join("\n");
  const sig = new Uint8Array(
    await crypto.subtle.sign("Ed25519", kp.privateKey, utf8Encoder.encode(signingString)),
  );
  return { sigB64: bytesToB64(sig), digest };
}

const sigHeader = (sigB64: string, algorithm = "ed25519") =>
  `keyid="acct-abc",algorithm="${algorithm}",signature="${sigB64}",headers="(request-target) host date digest"`;

const reqHeaders = (digest: string, sig: string): ReadonlyArray<readonly [string, string]> => [
  ["host", HOST],
  ["date", DATE],
  ["digest", digest],
  ["keygen-signature", sig],
];

describe("keygen bespoke (Ed25519 HTTP-Signatures)", () => {
  it("exposes keygen metadata", () => {
    const a = getAdapterForScheme("keygen")!;
    expect(a.scheme).toBe("keygen");
    expect(a.signatureHeader).toBe("keygen-signature");
  });

  it("verifies a valid Ed25519 HTTP-Signature over the reconstructed signing string", async () => {
    const { kp, pubHex } = await genKeypair();
    const { sigB64, digest } = await signKeygen(kp, BODY);
    const result = await getAdapterForScheme("keygen")!.verify({
      rawBody: BODY,
      headers: reqHeaders(digest, sigHeader(sigB64)),
      secrets: [pubHex],
      requestUrl: URL_STR,
      method: METHOD,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "keygen" });
  });

  it("rejects a tampered body (recomputed digest no longer matches the signed digest)", async () => {
    const { kp, pubHex } = await genKeypair();
    const { sigB64, digest } = await signKeygen(kp, BODY);
    const result = await getAdapterForScheme("keygen")!.verify({
      rawBody: utf8Encoder.encode('{"data":{"type":"webhook-events","id":"evt_TAMPERED"}}'),
      headers: reqHeaders(digest, sigHeader(sigB64)),
      secrets: [pubHex],
      requestUrl: URL_STR,
      method: METHOD,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a signature verified against the WRONG public key", async () => {
    const { kp } = await genKeypair();
    const other = await genKeypair(); // different key registered
    const { sigB64, digest } = await signKeygen(kp, BODY);
    const result = await getAdapterForScheme("keygen")!.verify({
      rawBody: BODY,
      headers: reqHeaders(digest, sigHeader(sigB64)),
      secrets: [other.pubHex],
      requestUrl: URL_STR,
      method: METHOD,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects when the (request-target) path differs from what was signed", async () => {
    const { kp, pubHex } = await genKeypair();
    const { sigB64, digest } = await signKeygen(kp, BODY);
    const result = await getAdapterForScheme("keygen")!.verify({
      rawBody: BODY,
      headers: reqHeaders(digest, sigHeader(sigB64)),
      secrets: [pubHex],
      requestUrl: "https://wbhk.my/a_different_path",
      method: METHOD,
    });
    expect(result.ok).toBe(false);
  });

  it("reports MISSING_HEADER when keygen-signature is absent", async () => {
    const { pubHex } = await genKeypair();
    const result = await getAdapterForScheme("keygen")!.verify({
      rawBody: BODY,
      headers: [["host", HOST]],
      secrets: [pubHex],
      requestUrl: URL_STR,
      method: METHOD,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MISSING_HEADER");
  });

  it("reports MALFORMED for an unsupported algorithm (e.g. rsa-pss-sha256)", async () => {
    const { kp, pubHex } = await genKeypair();
    const { sigB64, digest } = await signKeygen(kp, BODY);
    const result = await getAdapterForScheme("keygen")!.verify({
      rawBody: BODY,
      headers: reqHeaders(digest, sigHeader(sigB64, "rsa-pss-sha256")),
      secrets: [pubHex],
      requestUrl: URL_STR,
      method: METHOD,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });
});
