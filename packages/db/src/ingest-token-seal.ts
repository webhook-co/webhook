// The typed plaintext wrapper for the SEALED, recoverable copy of an endpoint's ingest token (S8-remainder,
// decision-0018 — the ingest URL becomes always-shown / retrievable, sealed at rest via the engine KMS).
//
// The token is sealed INSIDE a kind-tagged JSON blob so cross-kind confusion fails CLOSED at the plaintext
// layer. The seal AAD ({orgId, endpointId, keyId}) has no kind discriminator, so cross-kind separation
// otherwise rests only on keyId uniqueness; wrapping the plaintext means that even if a future generic
// reader ever fed the ingest unsealer a provider-secret / signing blob (or vice versa), parseIngestToken
// rejects anything that isn't an ingest-token blob — so a decrypt-anything oracle stays unrepresentable.
// Mirrors serializeBraintreePublicKey / serializeProviderSecretPlaintext. Single-sourced here so the seal
// side (packages/db create/rotate) and the reveal side (apps/engine) can never drift on the exact shape.

import { randomUUID } from "node:crypto";

import type { EncryptionContext, SecretSealer } from "@webhook-co/shared";

const INGEST_TOKEN_KIND = "ingest_token";

/** Seal-shape: wrap a raw ingest token into the typed blob the reveal path recognizes at unseal. */
export function serializeIngestToken(token: string): string {
  return JSON.stringify({ kind: INGEST_TOKEN_KIND, token });
}

/**
 * The inverse of {@link serializeIngestToken}: the unsealed ingest token if `plaintext` is an ingest-token
 * blob, else `null`. A bare token, a foreign-kind blob (provider secret / signing / braintree), malformed
 * JSON, a wrong/absent kind, or a non-string/empty token are all `null` — the cross-kind guard fails closed.
 */
export function parseIngestToken(plaintext: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const blob = parsed as { kind?: unknown; token?: unknown };
  if (blob.kind !== INGEST_TOKEN_KIND) return null;
  if (typeof blob.token !== "string" || blob.token.length === 0) return null;
  return blob.token;
}

/**
 * The sealed-ingest-token column values written on the endpoints row (all NULL when there is no recoverable
 * copy — no sealer wired, or the seal failed). The AAD keyId is `keyId`; enc_context is audit-only (the
 * reveal path rebuilds the AAD from the authoritative {org_id, id, ingest_key_id} columns, never this).
 */
export interface SealedIngestTokenColumns {
  readonly ciphertext: Buffer | null;
  readonly wrappedDek: Buffer | null;
  readonly kekRef: string | null;
  readonly nonce: Buffer | null;
  readonly encContext: EncryptionContext | null;
  readonly envelopeVersion: number | null;
  readonly keyId: string | null;
}

const NULL_SEAL: SealedIngestTokenColumns = {
  ciphertext: null,
  wrappedDek: null,
  kekRef: null,
  nonce: null,
  encContext: null,
  envelopeVersion: null,
  keyId: null,
};

/**
 * Seal a freshly-minted ingest token for at-rest storage on the endpoints row — BEFORE opening the write tx
 * (never hold a row `for update` lock across the seal RPC). Wraps the token in the typed blob, mints a fresh
 * random AAD keyId, and seals under {orgId, endpointId, keyId}. Returns the sealed columns, or ALL-NULL when
 * no sealer is wired OR the seal fails: the endpoint is still created/rotated from its hash (the recoverable
 * copy simply degrades to "rotate to reveal") — a KMS blip must never block the mutation. On rotate, ALWAYS
 * write the result (even NULL) so a failed reseal overwrites the prior seal rather than leaving a STALE one
 * behind the rotated hash (which would reveal a dead URL).
 */
export async function sealIngestTokenColumns(
  sealer: SecretSealer | undefined,
  orgId: string,
  endpointId: string,
  plaintext: string,
): Promise<SealedIngestTokenColumns> {
  if (!sealer) return NULL_SEAL;
  const keyId = randomUUID();
  const context: EncryptionContext = { orgId, endpointId, keyId };
  try {
    const sealed = await sealer.sealString(serializeIngestToken(plaintext), context);
    return {
      ciphertext: Buffer.from(sealed.ciphertext),
      wrappedDek: Buffer.from(sealed.wrapped.wrappedDek),
      kekRef: sealed.wrapped.kekRef,
      nonce: Buffer.from(sealed.nonce),
      encContext: context,
      envelopeVersion: sealed.envelopeVersion,
      keyId,
    };
  } catch (err) {
    // Fail-open on the STORAGE of the recoverable copy (not on the mutation): warn, degrade to NULL. WARN
    // (not log) so a bound-but-broken sealer — which would silently disable the always-shown URL fleet-wide
    // (every reveal returns null) — is a visible operational signal, not buried at log level. Emit only the
    // error CLASS (never String(err)): the sealer was handed the plaintext token, so an error that echoed
    // its argument could otherwise carry the token into logs. The class is enough to diagnose. (The seal RPC
    // is itself bounded — the AWS KMS provider aborts on a timeout — so a hung KMS cannot stall the mutation
    // beyond that bound; this catch then degrades it.)
    console.warn(
      JSON.stringify({
        message: "ingest_token.seal_failed",
        endpointId,
        error: err instanceof Error ? err.name : "unknown",
      }),
    );
    return NULL_SEAL;
  }
}
