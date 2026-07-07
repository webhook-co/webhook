// Dedup-key derivation for the wbhk.my write path. Dedup is a DERIVATION (recorded as
// dedup_strategy) so inspection can later explain why two events did or didn't collapse —
// not an SW-only column. First match wins:
//   1. sw_webhook_id      — the Standard-Webhooks `webhook-id` header.
//   2. provider_event_id  — a recognized provider's stable id (namespaced `<scheme>:<id>`).
//   3. content_hash       — `<method>:sha256(body):bucket` (method-scoped, coarse time bucket).
//
// CRITICAL: id extraction reads a PARSED COPY and must NEVER mutate the raw bytes — verification
// (a later slice) owns the exact captured bytes, and a single re-encoded byte breaks the provider
// HMAC. The single-table `INSERT ... ON CONFLICT (endpoint_id, dedup_key) DO NOTHING` is the
// idempotency gate; this only decides the key.

import {
  bytesToHex,
  DEFAULT_DEDUP_WINDOW_SECONDS,
  detectScheme,
  findHeader,
  type DedupConfig,
  type DedupStrategy,
  type Provider,
  type WebhookScheme,
} from "@webhook-co/shared";

import { evaluateFields } from "./dedup-fields";

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
 * The normalized per-provider event type (S3 Slice 3), for subscription routing. Header-borne (GitHub
 * `x-github-event`, Shopify `x-shopify-topic`) or body-borne (Stripe `.type`). null when unextracted —
 * the subscription matcher routes a null event_type via `*` only, so this never hard-fails ingest. Keyed by
 * the resolved provider SLUG (not the dedup scheme), since that is what the matcher and the event row use.
 * Start with the high-traffic providers; the rest degrade gracefully to `*`-only routing.
 */
export function extractEventType(
  provider: string | null,
  raw: Uint8Array,
  headers: Headers,
): string | null {
  switch (provider) {
    case "stripe":
      return jsonStringField(raw, "type"); // e.g. charge.succeeded
    case "github":
      return findHeader(headers, "x-github-event") ?? null; // e.g. push, pull_request
    case "shopify":
      return findHeader(headers, "x-shopify-topic") ?? null; // e.g. orders/create
    default:
      return null; // unextracted → routes via `*`
  }
}

/**
 * The resolved per-endpoint dedup parameters the engine feeds `deriveDedup`. Derived from the
 * endpoint's stored `DedupConfig` (or the default when unset) by `resolveDedupParams`.
 */
export type DedupParams =
  | { readonly mode: "identifier"; readonly windowMs: number }
  | { readonly mode: "content"; readonly windowMs: number }
  | {
      readonly mode: "fields";
      readonly windowMs: number;
      readonly include: readonly string[];
      readonly exclude: readonly string[];
    }
  | { readonly mode: "off" };

/**
 * The default params — a NULL/garbled config resolves to this. The default is OFF (no auto-dedup): every
 * request is captured as a distinct event. Deduplication is strictly OPT-IN per endpoint (identifier /
 * content / fields). (Founder decision: don't auto-dedupe — an inspection tool logs everything by default;
 * the soft-cap-pause is the billing backstop. Supersedes ADR-0104's original dedup-on-by-default.)
 */
export function defaultDedupParams(): DedupParams {
  return { mode: "off" };
}

/** NULL config → the default (OFF / log-everything). An explicit config selects opt-in dedup. */
export function resolveDedupParams(cfg: DedupConfig | null): DedupParams {
  if (cfg === null) return defaultDedupParams();
  // windowSeconds is schema-required for every mode EXCEPT off, but its TYPE is optional (off omits it),
  // so coalesce to the default window for the collapsing modes — defensive + type-safe (the `??` branch is
  // unreachable for a validated non-off config).
  const windowMs = (cfg.windowSeconds ?? DEFAULT_DEDUP_WINDOW_SECONDS) * 1000;
  switch (cfg.mode) {
    case "off":
      return { mode: "off" };
    case "content":
      return { mode: "content", windowMs };
    case "fields":
      return {
        mode: "fields",
        windowMs,
        include: cfg.fields?.include ?? [],
        exclude: cfg.fields?.exclude ?? [],
      };
    case "identifier":
      return { mode: "identifier", windowMs };
    default:
      // Defense-in-depth: config is validated at write time AND on the DB/KV read boundaries, so an
      // out-of-enum mode is unreachable without a DB compromise. Fall back to the safe default rather
      // than return undefined (which would throw in deriveDedup and 500 the ingest).
      return defaultDedupParams();
  }
}

// Only params that are UNAMBIGUOUSLY tracking / cache-busting are dropped. Params that could carry
// real request identity (e.g. `ts`, `nonce`, `attempt`, `sig`) are deliberately NOT stripped — stripping
// them would over-collapse two legitimately-distinct events that share a body and differ only in that
// param, and over-collapse (dropping a real event) is worse than under-dedup.
const VOLATILE_QUERY_PARAMS = new Set(["_", "cachebust", "cache_bust"]);
const MAX_CANONICAL_QUERY_PARAMS = 512;

function isVolatileParam(key: string): boolean {
  return VOLATILE_QUERY_PARAMS.has(key) || key.startsWith("utm_");
}

/**
 * A canonical `path?query` string folded into the content-hash key so two requests that differ only
 * in the URL are distinct. Volatile params (tracking/cache-busting/per-attempt) are dropped, remaining
 * params are sorted, and everything is re-encoded uniformly — so `?b=2&a=1` and `?a=1&b=2` collapse,
 * while `?id=1` and `?id=2` stay distinct. Duplicate keys are preserved (they are semantically distinct).
 */
function canonicalTarget(url: URL): string {
  let path = url.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  if (path === "") path = "/";
  const params = [...url.searchParams];
  if (params.length > MAX_CANONICAL_QUERY_PARAMS) {
    // Pathological param count: skip sorting (bounded work); the raw search is length-bounded by the URL.
    return `${path}?${url.search}`;
  }
  const kept = new URLSearchParams();
  for (const [k, v] of params) if (!isVolatileParam(k)) kept.append(k, v);
  kept.sort();
  const q = kept.toString();
  return q ? `${path}?${q}` : path;
}

const canonicalTargetEncoder = new TextEncoder();

async function contentHashResult(
  contentHash: Uint8Array,
  method: string,
  url: URL,
  bucket: number,
  provider: Provider | null,
): Promise<DerivedDedup> {
  // method + hash(canonical-target) + content hash + coarse bucket, all folded into the key. The method
  // keeps different verbs with the same (often empty) body distinct; the target hash keeps requests that
  // differ only by URL/query distinct; the bucket keeps a legitimately-identical request in a LATER window
  // distinct. The canonical target is HASHED (not inlined) so a multi-KB query string can't blow the
  // Postgres unique-index btree tuple limit and lose the event on insert. Same (method, target, body,
  // bucket) is a retry and collapses.
  const targetHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", canonicalTargetEncoder.encode(canonicalTarget(url))),
  );
  return {
    dedupKey: `${method}:${bytesToHex(contentHash)}:${bytesToHex(targetHash)}:${bucket}`,
    dedupStrategy: "content_hash",
    provider,
    providerEventId: null,
    dedupBucket: bucket,
    contentHash,
  };
}

function uniqueResult(
  eventId: string,
  contentHash: Uint8Array,
  provider: Provider | null,
): DerivedDedup {
  // A per-request unique key: off mode, or the fail-safe when a configured field is unresolvable.
  return {
    dedupKey: `unique:${eventId}`,
    dedupStrategy: "unique",
    provider,
    providerEventId: null,
    dedupBucket: null,
    contentHash,
  };
}

/**
 * Derive `{dedup_key, dedup_strategy, provider, provider_event_id, dedup_bucket}` (+ the content
 * hash) from the raw body + ordered headers + request URL, per the endpoint's resolved `params`.
 * `now` is the server-assigned receive time; `eventId` a pre-minted uuidv7 used for `off`/fail-safe.
 */
export async function deriveDedup(
  rawBody: Uint8Array,
  headers: Headers,
  method: string,
  url: URL,
  eventId: string,
  now: Date,
  params: DedupParams,
): Promise<DerivedDedup> {
  const contentHash = new Uint8Array(await crypto.subtle.digest("SHA-256", rawBody));
  const scheme = detectScheme(headers);
  const provider = schemeToProvider(scheme);

  // off — every request is a distinct event (opt-in; idempotency disabled).
  if (params.mode === "off") return uniqueResult(eventId, contentHash, provider);

  // fields — key from the endpoint's configured selectors; fail safe to a unique key, or degrade to a
  // whole-body content hash when the payload is too large / has too many values (both bounded, safe).
  if (params.mode === "fields") {
    const evaluated = evaluateFields(rawBody, headers, url, params.include, params.exclude);
    if (evaluated.kind === "unique") return uniqueResult(eventId, contentHash, provider);
    const bucket = Math.floor(now.getTime() / params.windowMs);
    if (evaluated.kind === "content")
      return await contentHashResult(contentHash, method, url, bucket, provider);
    const fieldsHash = new Uint8Array(await crypto.subtle.digest("SHA-256", evaluated.bytes));
    return {
      dedupKey: `fields:${bytesToHex(fieldsHash)}:${bucket}`,
      dedupStrategy: "fields",
      provider,
      providerEventId: null,
      dedupBucket: bucket,
      contentHash,
    };
  }

  // identifier — the id ladder (stable across retries), then the content-hash fallback below.
  if (params.mode === "identifier") {
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
  }

  // content mode, or the identifier fallback: canonical content hash + a coarse time bucket.
  const bucket = Math.floor(now.getTime() / params.windowMs);
  return await contentHashResult(contentHash, method, url, bucket, provider);
}
