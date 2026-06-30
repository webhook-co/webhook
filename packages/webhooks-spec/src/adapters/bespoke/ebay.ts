// eBay Event Notifications — the inbound notification SIGNATURE verification (separate from the GET
// challenge handshake, which is credential-free and lives on the ingest path). eBay signs each POST with
// `SHA1withECDSA` (ECDSA P-256 over SHA-1) and ships the signature in the `X-EBAY-SIGNATURE` header as
// base64( JSON { alg, kid, signature, digest } ), where `signature` is a base64 DER ECDSA signature over the
// RAW body. Verifying needs eBay's public key, fetched by `kid` from an AUTHENTICATED endpoint
// (`GET /commerce/notification/v1/public_key/{kid}` with an application access token) — so this is the only
// adapter that must (1) mint a client-credentials token and (2) fetch the key with it. The registered
// "secret" is therefore the operator's eBay APP credentials as a JSON blob
// `{"clientId":"…","clientSecret":"…","env":"production"|"sandbox"}`. Both fetches are host-pinned to
// `api.ebay.com`/`api.sandbox.ebay.com`, cached, and fail-soft (KEY_FETCH_FAILED).
//
// NOTE: verified against eBay's documented spec + self-generated SHA1withECDSA vectors (see ebay.test.ts);
// NOT yet validated against a live eBay notification (that needs a real eBay app). The challenge handshake
// (apps/engine/src/handshake.ts) IS live-verifiable and is the credential-free subscription unblock.

import { b64ToBytes, bytesToB64, utf8Decoder, utf8Encoder } from "../../bytes";
import type { VerifyAdapter, VerifyInput } from "../../adapter";
import { verificationFailed, verificationOk, type VerificationResult } from "../../verification";
import { derEcdsaSigToRaw, pemToDer, verifyEcdsaP256Sha1 } from "../asymmetric";
import { PROVIDER_TOLERANCE_SECONDS } from "../config";
import { findHeader } from "../shared";

const SIG_HEADER = "x-ebay-signature";
const TOKEN_TTL_SECONDS = 90 * 60; // eBay app tokens live ~2h; refresh comfortably inside that
const KEY_TTL_SECONDS = 60 * 60; // eBay recommends caching the public key ~1h
const OAUTH_SCOPE = "https://api.ebay.com/oauth/api_scope";
const ENV_BASE: Readonly<Record<string, string>> = {
  production: "https://api.ebay.com",
  sandbox: "https://api.sandbox.ebay.com",
};
const ALLOWED_HOSTS = ["api.ebay.com", "api.sandbox.ebay.com"] as const;

interface EbayCreds {
  readonly env: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Parse the registered JSON secret into eBay app creds. null on malformation / unknown env (env default production). */
function parseCreds(raw: string): EbayCreds | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  const env = typeof o.env === "string" ? o.env : "production";
  if (!(env in ENV_BASE)) return null;
  if (typeof o.clientId !== "string" || o.clientId.length === 0) return null;
  if (typeof o.clientSecret !== "string" || o.clientSecret.length === 0) return null;
  return { env, clientId: o.clientId, clientSecret: o.clientSecret };
}

interface EbaySig {
  readonly kid: string;
  readonly signatureDer: Uint8Array;
}

/** Parse `X-EBAY-SIGNATURE` (base64 JSON {kid, signature}) into the kid + DER signature bytes. null on any malformation. */
function parseSignatureHeader(headerValue: string): EbaySig | null {
  const jsonBytes = b64ToBytes(headerValue);
  if (jsonBytes === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decoder.decode(jsonBytes));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.kid !== "string" || o.kid.length === 0) return null;
  if (typeof o.signature !== "string" || o.signature.length === 0) return null;
  const signatureDer = b64ToBytes(o.signature);
  if (signatureDer === null) return null;
  return { kid: o.kid, signatureDer };
}

/** Extract the access token from the client-credentials token response (`{ access_token }`). null if absent. */
function parseAccessToken(bytes: Uint8Array): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decoder.decode(bytes));
  } catch {
    return null;
  }
  const tok = (parsed as { access_token?: unknown } | null)?.access_token;
  return typeof tok === "string" && tok.length > 0 ? tok : null;
}

/** Extract the X509 EC public key (SPKI DER) from a getPublicKey response (`{ key }`); accepts PEM or bare base64. */
function parsePublicKeySpki(bytes: Uint8Array): Uint8Array | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decoder.decode(bytes));
  } catch {
    return null;
  }
  const key = (parsed as { key?: unknown } | null)?.key;
  if (typeof key !== "string" || key.length === 0) return null;
  return key.includes("BEGIN") ? pemToDer(key) : b64ToBytes(key);
}

export function makeEbayAdapter(): VerifyAdapter {
  const toleranceSeconds = PROVIDER_TOLERANCE_SECONDS.ebay;

  async function verify(input: VerifyInput): Promise<VerificationResult> {
    const headerValue = findHeader(input.headers, SIG_HEADER);
    if (headerValue === undefined) {
      return verificationFailed({ code: "MISSING_HEADER", header: SIG_HEADER, scheme: "ebay" });
    }
    const sig = parseSignatureHeader(headerValue);
    if (sig === null) {
      return verificationFailed({
        code: "MALFORMED_SIGNATURE",
        detail: "x-ebay-signature is not base64 JSON {kid, signature}",
        scheme: "ebay",
      });
    }
    const signatureRaw = derEcdsaSigToRaw(sig.signatureDer);
    if (signatureRaw === null) {
      return verificationFailed({
        code: "MALFORMED_SIGNATURE",
        detail: "signature is not a DER ECDSA signature",
        scheme: "ebay",
      });
    }
    if (input.fetchKey === undefined) {
      return verificationFailed({ code: "KEY_FETCH_FAILED", scheme: "ebay" });
    }
    const fetchKey = input.fetchKey;

    let sawUsableSecret = false;
    let fetchFailed = false;
    for (let i = 0; i < input.secrets.length; i++) {
      const creds = parseCreds(input.secrets[i]!);
      if (creds === null) continue; // verify-token blobs / non-creds secrets are skipped
      sawUsableSecret = true;
      const base = ENV_BASE[creds.env]!;

      // 1) mint an application access token (client-credentials), cached per clientId+env.
      const basic = bytesToB64(utf8Encoder.encode(`${creds.clientId}:${creds.clientSecret}`));
      const tokenBytes = await fetchKey({
        cacheKey: `ebay-token:${creds.env}:${creds.clientId}`,
        url: `${base}/identity/v1/oauth2/token`,
        allowedHosts: [...ALLOWED_HOSTS],
        method: "POST",
        body: `grant_type=client_credentials&scope=${encodeURIComponent(OAUTH_SCOPE)}`,
        headers: [
          ["authorization", `Basic ${basic}`],
          ["content-type", "application/x-www-form-urlencoded"],
        ],
        ttlSeconds: TOKEN_TTL_SECONDS,
      });
      if (tokenBytes === null) {
        fetchFailed = true;
        continue;
      }
      const token = parseAccessToken(tokenBytes);
      if (token === null) {
        fetchFailed = true;
        continue;
      }

      // 2) fetch the signing public key by kid, with the minted Bearer token, cached per kid.
      const keyBytes = await fetchKey({
        cacheKey: `ebay-key:${creds.env}:${sig.kid}`,
        url: `${base}/commerce/notification/v1/public_key/${encodeURIComponent(sig.kid)}`,
        allowedHosts: [...ALLOWED_HOSTS],
        method: "GET",
        headers: [["authorization", `Bearer ${token}`]],
        ttlSeconds: KEY_TTL_SECONDS,
      });
      if (keyBytes === null) {
        fetchFailed = true;
        continue;
      }
      const spki = parsePublicKeySpki(keyBytes);
      if (spki === null) {
        fetchFailed = true;
        continue;
      }
      if (await verifyEcdsaP256Sha1(spki, input.rawBody, signatureRaw)) {
        return verificationOk(`secret_${i}`, "ebay");
      }
      // wrong key/creds for this kid — try the next registered secret
    }

    if (!sawUsableSecret) return verificationFailed({ code: "NO_MATCHING_KEY", keysTried: 0 });
    if (fetchFailed) return verificationFailed({ code: "KEY_FETCH_FAILED", scheme: "ebay" });
    return verificationFailed({ code: "SIGNATURE_MISMATCH" });
  }

  return { scheme: "ebay", signatureHeader: SIG_HEADER, toleranceSeconds, verify };
}
