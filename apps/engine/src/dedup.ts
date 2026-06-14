// Dedup-key derivation for the wbhk.my write path. Dedup is a DERIVATION (recorded as
// dedup_strategy) so inspection can later explain why two events did or didn't collapse —
// not an SW-only column. First match wins:
//   1. sw_webhook_id      — the Standard-Webhooks `webhook-id` header.
//   2. provider_event_id  — a recognized provider's stable id (namespaced `<scheme>:<id>`).
//   3. content_hash       — sha256(body) folded with a coarse time bucket (bounds the window).
//
// CRITICAL: id extraction reads a PARSED COPY and must NEVER mutate the raw bytes — verification
// (a later slice) owns the exact captured bytes, and a single re-encoded byte breaks the provider
// HMAC. The single-table `INSERT ... ON CONFLICT (endpoint_id, dedup_key) DO NOTHING` is the
// idempotency gate; this only decides the key.

import {
  bytesToHex,
  detectScheme,
  findHeader,
  type DedupStrategy,
  type Provider,
  type WebhookScheme,
} from "@webhook-co/shared";

/**
 * Map a detected scheme to its Provider (null for "unknown"). The `return scheme` below is a
 * COMPILE-TIME parity check: it only type-checks while `Exclude<WebhookScheme,"unknown">` is exactly
 * assignable to `Provider`, so adding a scheme without a matching provider (or vice versa) breaks
 * the build here instead of silently storing a bad provider.
 */
function schemeToProvider(scheme: WebhookScheme): Provider | null {
  if (scheme === "unknown") return null;
  return scheme;
}

const utf8Decoder = new TextDecoder();

export interface DerivedDedup {
  readonly dedupKey: string;
  readonly dedupStrategy: DedupStrategy;
  /** Best-effort detected provider (null when the sender is unrecognized). */
  readonly provider: Provider | null;
  /** The extracted provider id (provider_event_id strategy only). */
  readonly providerEventId: string | null;
  /** The coarse time bucket (content_hash strategy only). */
  readonly dedupBucket: number | null;
  /** sha256(rawBody) — always computed: integrity + the content_hash strategy. */
  readonly contentHash: Uint8Array;
}

type Headers = ReadonlyArray<readonly [string, string]>;

/** Read `field` from a JSON parse of a COPY of the bytes; null on parse failure or absence. */
function jsonStringField(raw: Uint8Array, field: string): string | null {
  try {
    const parsed: unknown = JSON.parse(utf8Decoder.decode(raw));
    if (typeof parsed !== "object" || parsed === null) return null;
    const value = (parsed as Record<string, unknown>)[field];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** A provider's stable event id, by scheme — header-borne or body-borne (parsed copy only). */
function extractProviderEventId(
  scheme: WebhookScheme,
  raw: Uint8Array,
  headers: Headers,
): string | null {
  switch (scheme) {
    case "github":
      return findHeader(headers, "x-github-delivery") ?? null; // per-delivery guid (recorded choice)
    case "shopify":
      return findHeader(headers, "x-shopify-webhook-id") ?? null;
    case "stripe":
      return jsonStringField(raw, "id"); // evt_...
    case "slack":
      return jsonStringField(raw, "event_id"); // Ev...
    default:
      return null; // standard_webhooks -> sw_webhook_id above; unknown -> none
  }
}

/**
 * Derive `{dedup_key, dedup_strategy, provider, provider_event_id, dedup_bucket}` (+ the content
 * hash) from the raw body + ordered headers. `now` is the server-assigned receive time and
 * `bucketWidthMs` the content-hash window (≥ the provider retry window where known).
 */
export async function deriveDedup(
  rawBody: Uint8Array,
  headers: Headers,
  now: Date,
  bucketWidthMs: number,
): Promise<DerivedDedup> {
  const contentHash = new Uint8Array(await crypto.subtle.digest("SHA-256", rawBody));
  const scheme = detectScheme(headers);
  const provider = schemeToProvider(scheme);

  // 1. Standard Webhooks id (stable across retries, SW-native senders).
  const webhookId = findHeader(headers, "webhook-id");
  if (webhookId) {
    return {
      dedupKey: webhookId,
      dedupStrategy: "sw_webhook_id",
      provider,
      providerEventId: null,
      dedupBucket: null,
      contentHash,
    };
  }

  // 2. Provider event id, namespaced by scheme.
  const providerEventId = extractProviderEventId(scheme, rawBody, headers);
  if (providerEventId) {
    return {
      dedupKey: `${scheme}:${providerEventId}`,
      dedupStrategy: "provider_event_id",
      provider,
      providerEventId,
      dedupBucket: null,
      contentHash,
    };
  }

  // 3. content_hash + a coarse time bucket, folded into the key so a legitimately-identical body
  //    sent in a later bucket isn't collapsed.
  const dedupBucket = Math.floor(now.getTime() / bucketWidthMs);
  return {
    dedupKey: `${bytesToHex(contentHash)}:${dedupBucket}`,
    dedupStrategy: "content_hash",
    provider,
    providerEventId: null,
    dedupBucket,
    contentHash,
  };
}
