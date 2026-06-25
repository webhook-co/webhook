// GitHub Secret Scanning Partner Program webhook (ADR-0074). GitHub scans public repos/gists for
// our `whk_` token shape and POSTs signed matches here; we verify the signature, auto-revoke any
// leaked key, and answer with a true/false_positive label per token.
//
// UNAUTHENTICATED by design — GitHub sends no bearer; the ECDSA signature over the RAW body IS the
// authentication. The endpoint does cheap, no-DB work first (size cap → key-id → signature) and only
// touches the database AFTER the signature verifies, so an unsigned caller cannot force DB/egress work.
//
// Signature: ECDSA-NIST-P256V1-SHA256, signature is base64 ASN.1/DER. We verify with WebCrypto
// (native + guaranteed on workerd) after converting DER → raw r‖s — NOT node:crypto sign/verify
// (its EC-key support on workerd is uncertain). The checksum (ADR-0073) is the cheap false-positive
// filter; it is NOT a security control.

import {
  API_KEY_PREFIX,
  createClient,
  createCredentialHasherFromBase64,
  credentialCacheKey,
  revokeApiKeyByPlaintext,
  verifyKeyChecksum,
} from "@webhook-co/db";
import { b64ToBytes, importAuditKey, readSecretBinding } from "@webhook-co/shared";

/** The Worker bindings this handler needs (a structural subset of apps/api's Env). */
export interface SecretScanningEnv {
  readonly HYPERDRIVE_AUTHN: Hyperdrive;
  readonly HYPERDRIVE_TENANT: Hyperdrive;
  readonly KV_AUTHZ: KVNamespace;
  readonly CREDENTIAL_PEPPER: SecretsStoreSecret;
  readonly AUDIT_CHAIN_HMAC_KEY: SecretsStoreSecret;
}

/** The unique secret type we registered with GitHub; echoed back per token (default if GitHub omits it). */
const TOKEN_TYPE = "webhook_co_api_key";
/** GitHub batches are small; cap the body + array so an (already-signature-gated) request can't be huge. */
const MAX_BODY_BYTES = 256 * 1024;
const MAX_TOKENS = 200;

const GITHUB_KEYS_URL = "https://api.github.com/meta/public_keys/secret_scanning";
const KEYS_CACHE_KEY = "ssk:secret_scanning_keys";
const FETCH_LOCK_KEY = "ssk:fetchlock";
const KEYS_TTL_SECONDS = 3600; // refresh the key set hourly
const FETCH_LOCK_TTL_SECONDS = 60; // ...but never re-fetch more than once a minute (bounds egress)

export interface SecretMatch {
  readonly token: string;
  readonly type?: string;
  readonly url?: string;
  readonly source?: string;
}

export interface ScanLabel {
  readonly token_raw: string;
  readonly token_type: string;
  readonly label: "true_positive" | "false_positive";
}

const text = (status: number, body: string): Response =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Strip a PEM envelope to its base64-decoded DER (SubjectPublicKeyInfo) bytes. */
function pemToDer(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  return base64ToBytes(b64);
}

/**
 * Convert an ASN.1/DER ECDSA signature (`SEQUENCE { INTEGER r, INTEGER s }`) to the fixed 64-byte
 * raw r‖s WebCrypto expects for P-256. Strips each integer's sign-padding leading 0x00 and
 * left-pads to 32 bytes. Throws on malformed DER (the caller treats a throw as "invalid signature").
 */
function derToRawEcdsaSig(der: Uint8Array): Uint8Array {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error("der: expected sequence");
  // SEQUENCE length: short form for a P-256 sig (~70 bytes < 0x80); skip long-form length bytes if present.
  const seqLenByte = der[i];
  if (seqLenByte === undefined) throw new Error("der: truncated");
  i += seqLenByte & 0x80 ? 1 + (seqLenByte & 0x7f) : 1;
  const readInt = (): Uint8Array => {
    if (der[i++] !== 0x02) throw new Error("der: expected integer");
    const len = der[i++]!;
    let v = der.subarray(i, i + len);
    i += len;
    while (v.length > 32 && v[0] === 0x00) v = v.subarray(1);
    if (v.length > 32) throw new Error("der: integer too long");
    return v;
  };
  const r = readInt();
  const s = readInt();
  const out = new Uint8Array(64);
  out.set(r, 32 - r.length);
  out.set(s, 64 - s.length);
  return out;
}

/**
 * Verify a GitHub secret-scanning signature: base64 DER ECDSA-P256-SHA256 over the RAW body, against
 * a PEM public key. Returns false (never throws) for any malformed key/signature — a bad signature is
 * indistinguishable from an attack and must fail closed.
 */
export async function verifyGithubSignature(
  rawBody: Uint8Array,
  publicKeyPem: string,
  signatureB64: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      pemToDer(publicKeyPem) as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const raw = derToRawEcdsaSig(base64ToBytes(signatureB64));
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      raw as BufferSource,
      rawBody as BufferSource,
    );
  } catch {
    return false;
  }
}

/**
 * Label each reported token and revoke ours. A token that FAILS the checksum is definitively not a
 * real `whk_` key → `false_positive` (GitHub suppresses the alert), no revoke. A checksum-passing
 * token IS our shape → `true_positive` (revoking is a side-effect, not the label criterion); we never
 * tell GitHub to suppress our own valid shape, even if the key isn't in our DB. Pure over the injected
 * `isWellFormed`/`revoke` seams (so it's unit-testable without crypto/DB).
 */
export async function classifyAndRevoke(
  tokens: readonly SecretMatch[],
  deps: { isWellFormed: (token: string) => boolean; revoke: (token: string) => Promise<void> },
): Promise<ScanLabel[]> {
  const out: ScanLabel[] = [];
  for (const m of tokens) {
    const token_type = m.type ?? TOKEN_TYPE;
    if (!deps.isWellFormed(m.token)) {
      out.push({ token_raw: m.token, token_type, label: "false_positive" });
      continue;
    }
    await deps.revoke(m.token);
    out.push({ token_raw: m.token, token_type, label: "true_positive" });
  }
  return out;
}

/** Resolve GitHub's secret_scanning public key for `keyId`, KV-cached with a bounded refresh. */
async function getGithubPublicKey(env: SecretScanningEnv, keyId: string): Promise<string | null> {
  const cachedRaw = await env.KV_AUTHZ.get(KEYS_CACHE_KEY);
  if (cachedRaw !== null) {
    let cached: Record<string, string> | null;
    try {
      cached = JSON.parse(cachedRaw) as Record<string, string>;
    } catch {
      cached = null;
    }
    if (cached?.[keyId]) return cached[keyId]!;
  }
  // A (re)fetch is needed — either the cache is cold/expired, or this key-id is absent (rotation or a
  // bogus id). Bound it: at most one fetch per FETCH_LOCK window, GLOBALLY (both the cold-cache and
  // missing-key-id paths), so neither a cold-start stampede nor an attacker spamming random key-ids
  // can drive unbounded egress. A request that arrives while the lock is held gets null (→ 401); for a
  // VALID key-id that's a rare transient the moment after expiry (GitHub retries), and for a bogus
  // key-id it's the intended rejection.
  if ((await env.KV_AUTHZ.get(FETCH_LOCK_KEY)) !== null) return null;
  await env.KV_AUTHZ.put(FETCH_LOCK_KEY, "1", { expirationTtl: FETCH_LOCK_TTL_SECONDS });
  const fresh = await fetchKeysFromGithub();
  await env.KV_AUTHZ.put(KEYS_CACHE_KEY, JSON.stringify(fresh), {
    expirationTtl: KEYS_TTL_SECONDS,
  });
  return fresh[keyId] ?? null;
}

async function fetchKeysFromGithub(): Promise<Record<string, string>> {
  const res = await fetch(GITHUB_KEYS_URL, {
    headers: { "user-agent": "webhook.co-secret-scanning", accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`github public_keys fetch failed: ${res.status}`);
  const body = (await res.json()) as {
    public_keys?: { key_identifier?: string; public_key?: string }[];
  };
  const map: Record<string, string> = {};
  for (const k of body.public_keys ?? []) {
    if (typeof k.key_identifier === "string" && typeof k.public_key === "string") {
      map[k.key_identifier] = k.public_key;
    }
  }
  return map;
}

/**
 * The `POST /secret-scanning/github` handler. Cheap guards → DER-ECDSA signature verify (no DB) →
 * (only if a token is actually ours) revoke + KV-evict + audit → per-token labels. Builds its own
 * short-lived DB clients and tears them down in a finally; never touches the DB on an unsigned request.
 */
export async function handleGithubSecretScanning(
  request: Request,
  env: SecretScanningEnv,
): Promise<Response> {
  const declaredLen = request.headers.get("content-length");
  if (declaredLen !== null && Number(declaredLen) > MAX_BODY_BYTES)
    return text(413, "payload too large");
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES) return text(413, "payload too large");

  const keyId = request.headers.get("github-public-key-identifier");
  const signature = request.headers.get("github-public-key-signature");
  if (keyId === null || signature === null) return text(401, "missing signature");

  let pem: string | null;
  try {
    pem = await getGithubPublicKey(env, keyId);
  } catch (err) {
    console.log(
      JSON.stringify({ message: "secret_scanning.keys_unavailable", error: String(err) }),
    );
    return text(503, "verification keys unavailable");
  }
  if (pem === null) return text(401, "unknown key identifier");
  if (!(await verifyGithubSignature(raw, pem, signature))) return text(401, "invalid signature");

  // Signature verified — now (and only now) parse + act.
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return text(400, "invalid json");
  }
  if (!Array.isArray(parsed)) return text(400, "expected an array");
  if (parsed.length > MAX_TOKENS) return text(413, "too many tokens");
  const tokens: SecretMatch[] = parsed
    .filter(
      (m): m is { token: string; type?: unknown } => typeof (m as SecretMatch)?.token === "string",
    )
    .map((m) => ({ token: m.token, type: typeof m.type === "string" ? m.type : undefined }));

  const isWellFormed = (token: string): boolean => verifyKeyChecksum(API_KEY_PREFIX, token);

  // No token is ours → all false_positive, no DB connection opened.
  if (!tokens.some((m) => isWellFormed(m.token))) {
    return Response.json(await classifyAndRevoke(tokens, { isWellFormed, revoke: async () => {} }));
  }

  const [pepper, auditRaw] = await Promise.all([
    readSecretBinding(env.CREDENTIAL_PEPPER),
    readSecretBinding(env.AUDIT_CHAIN_HMAC_KEY),
  ]);
  const hasher = createCredentialHasherFromBase64(pepper);
  const auditKey = await importAuditKey(b64ToBytes(auditRaw));
  const authn = createClient(env.HYPERDRIVE_AUTHN.connectionString, { max: 1 });
  const tenant = createClient(env.HYPERDRIVE_TENANT.connectionString, { max: 1 });
  try {
    const labels = await classifyAndRevoke(tokens, {
      isWellFormed,
      revoke: async (token) => {
        const r = await revokeApiKeyByPlaintext(authn, tenant, token, hasher, auditKey);
        // Evict the KV credential-cache entry so the revoke takes effect before the TTL backstop.
        if (r.keyHash !== null) await env.KV_AUTHZ.delete(credentialCacheKey(r.keyHash));
        if (r.revoked) {
          // Out-of-band alert: a leaked key was auto-revoked. (A real alert channel is a follow-up.)
          console.log(
            JSON.stringify({
              message: "secret_scanning.key_revoked",
              orgId: r.orgId,
              keyId: r.keyId,
            }),
          );
        }
      },
    });
    return Response.json(labels);
  } finally {
    await Promise.allSettled([authn.end(), tenant.end()]);
  }
}
