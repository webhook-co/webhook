// A4c-1 — a durable, KV-backed fixed-window rate limiter.
//
// The issuer's public, unauthenticated-ish endpoints are guessable/floodable (the device user-code is
// ~40 bits; magic-link + /token + /authorize are public). Better Auth's built-in limiter is in-memory =
// per-isolate on Workers, so it's ineffective fleet-wide; this is the durable replacement, shared by the
// device verify path (A4c-2) and — at the deploy slice — magic-link / token / authorize.
//
// Fixed-window counter: one KV key per (bucket, window), incremented per attempt, TTL'd to the window.
// Two accepted trade-offs (a throttle, not a hard quota): (1) a burst at a window boundary can admit up to
// 2× the limit across the seam; (2) KV's non-transactional read-then-write can under-count under heavy
// concurrency (admitting a few extra). Both are fine for abuse-throttling and avoid a per-request DO. The
// bucket (which may be an IP / principal) is hashed into the key so a KV listing never exposes raw inputs.

import { bytesToHex, utf8Encoder } from "@webhook-co/shared";

/** The minimal KV surface used (avoids the Workers-global KVNamespace type under the DOM tsconfig). */
export interface RateLimitKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts: { expirationTtl: number }): Promise<void>;
}

export interface RateLimitDeps {
  kv: RateLimitKv;
  nowSeconds: () => number;
}

export interface RateLimitRule {
  /** Max attempts permitted within a window. */
  limit: number;
  /** Window length in seconds (KV requires ≥ 60). */
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Attempts left in the current window (0 when denied). */
  remaining: number;
  /** Seconds until the window resets — for the Retry-After header (0 when allowed). */
  retryAfterSeconds: number;
  /** Seconds until the window resets — always set (for an informational RateLimit-Reset header). */
  resetSeconds: number;
}

// Cloudflare KV rejects expirationTtl < 60s; clamp so a short window still persists its counter (the
// window math is driven by windowSeconds independently of the KV TTL, so a longer-lived key for a short
// window is harmless — a past window's key is never read again).
const MIN_KV_TTL_SECONDS = 60;

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    utf8Encoder.encode(input) as Uint8Array<ArrayBuffer>,
  );
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Consume one unit against `bucket` under `rule`. Returns whether it's allowed plus the remaining budget
 * and the window reset. Call once per protected attempt; deny (don't process) when `allowed` is false.
 *
 * Failure posture (the caller decides): a KV get/put error PROPAGATES — guess-throttled endpoints should
 * catch and DENY (a KV outage must not become an open guessing window). A malformed stored counter fails
 * OPEN (treated as 0); that's bounded only because the key is hashed + KV is write-protected (no attacker
 * can seed a corrupt counter).
 */
export async function consumeRateLimit(
  deps: RateLimitDeps,
  bucket: string,
  rule: RateLimitRule,
): Promise<RateLimitResult> {
  const now = deps.nowSeconds();
  const windowIndex = Math.floor(now / rule.windowSeconds);
  const windowEnd = (windowIndex + 1) * rule.windowSeconds;
  const resetSeconds = Math.max(1, windowEnd - now);
  const key = `rl:${await sha256Hex(`${bucket}:${windowIndex}`)}`;

  const current = Number.parseInt((await deps.kv.get(key)) ?? "0", 10);
  const count = Number.isFinite(current) && current > 0 ? current : 0;

  if (count >= rule.limit) {
    return { allowed: false, remaining: 0, retryAfterSeconds: resetSeconds, resetSeconds };
  }

  // TTL covers the window (+ buffer), clamped to KV's 60s minimum so a short window can't make the put throw.
  await deps.kv.put(key, String(count + 1), {
    expirationTtl: Math.max(MIN_KV_TTL_SECONDS, rule.windowSeconds + 5),
  });
  return { allowed: true, remaining: rule.limit - (count + 1), retryAfterSeconds: 0, resetSeconds };
}
