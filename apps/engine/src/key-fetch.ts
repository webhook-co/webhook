// The engine's implementation of the verify adapters' `fetchKey` capability: fetch a remote verification
// key/cert (Tier-3 remote-fetch providers) on the durable ingest path, behind a hard SSRF guard and a
// per-isolate TTL cache, FAIL-SOFT throughout. It NEVER throws and NEVER returns anything but the response
// bytes of an allowed, successful, bounded fetch — every other outcome is null, which the adapter maps to
// KEY_FETCH_FAILED (the event is captured unverified, never dropped, never blocked past the timeout).
//
// SSRF posture (the load-bearing part — PayPal/SNS take the fetch URL FROM the inbound message):
//   - https only;
//   - the URL host must match the adapter-supplied allowlist (a hardcoded provider host, or an
//     operator-registered issuer host) EXACTLY — a substring check is the classic bypass;
//   - redirects are refused (`redirect: "error"`) so an allowed host can't 30x us to an arbitrary one;
//   - the response is size-capped (certs/JWKS are small) and timed out.

import type { KeyFetcher, KeyFetchSpec } from "@webhook-co/shared";

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_RESPONSE_BYTES = 64 * 1024; // X.509 certs and JWKS are well under this
// Cap the per-isolate cache so a provider whose cacheKey varies per message (e.g. SNS/PayPal cert URLs)
// can't grow it without bound; evict oldest-first on overflow (a Map preserves insertion order).
const MAX_CACHE_ENTRIES = 256;

interface CacheEntry {
  readonly bytes: Uint8Array;
  readonly expiresAtMs: number;
}

/** Per-isolate key/cert cache. Keyed by the adapter's cacheKey (cert URL / `<issuer>:jwks` / `<env>:<kid>`). */
const keyCache = new Map<string, CacheEntry>();

// Match the request host against the allowlist. NB: a RegExp allowlist MUST be fully ANCHORED (`^…$`) — an
// unanchored pattern like `/sns\..*\.amazonaws\.com/` would also match `sns.x.amazonaws.com.evil.com`.
// `hostname` (not `host`) drops the port so the comparison isn't port-ambiguous.
function hostAllowed(hostname: string, allowed: readonly string[] | RegExp): boolean {
  return allowed instanceof RegExp ? allowed.test(hostname) : allowed.includes(hostname);
}

/**
 * Build the `fetchKey` capability. `nowMs` is injectable for deterministic cache-expiry tests; `doFetch`
 * defaults to the global `fetch` (injectable so tests don't hit the network).
 */
export function makeKeyFetcher(
  nowMs: () => number = () => Date.now(),
  doFetch: typeof fetch = fetch,
): KeyFetcher {
  return async function fetchKey(spec: KeyFetchSpec): Promise<Uint8Array | null> {
    const cached = keyCache.get(spec.cacheKey);
    if (cached !== undefined && cached.expiresAtMs > nowMs()) return cached.bytes;

    // SSRF guard: https + an exactly-allowed host, evaluated BEFORE any network call.
    let url: URL;
    try {
      url = new URL(spec.url);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" || !hostAllowed(url.hostname, spec.allowedHosts)) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const response = await doFetch(url.toString(), {
        method: spec.method ?? "GET",
        body: spec.body,
        headers: spec.headers === undefined ? undefined : spec.headers.map(([k, v]) => [k, v]),
        signal: controller.signal,
        redirect: "error", // refuse redirects — a 30x from the allowed host could escape the host pin
      });
      if (!response.ok) return null;
      // Short-circuit an oversize body via Content-Length before buffering it (best-effort — the post-read
      // length check below is authoritative for chunked responses without the header).
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_RESPONSE_BYTES) return null;
      if (keyCache.size >= MAX_CACHE_ENTRIES) {
        const oldest = keyCache.keys().next().value;
        if (oldest !== undefined) keyCache.delete(oldest);
      }
      keyCache.set(spec.cacheKey, { bytes, expiresAtMs: nowMs() + spec.ttlSeconds * 1000 });
      return bytes;
    } catch {
      return null; // timeout / abort / network / redirect-refused → fail-soft (NOT cached)
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Clear the per-isolate cache (tests). */
export function _clearKeyCache(): void {
  keyCache.clear();
}
