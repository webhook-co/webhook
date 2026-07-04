// Retry/backoff primitives — pure and injectable (the jitter source is a parameter) so every caller is
// tested with no real timers. The HTTP core decides WHICH requests are retry-safe (idempotency gating);
// this module owns only the timing math and the transient-status classification.

/** Default retries AFTER the first attempt (so 3 total attempts). Overridable per client. */
export const DEFAULT_MAX_RETRIES = 2;
/** Per-request wall-clock budget before the request aborts (and, if idempotent, retries). */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Backoff base (the first retry wait grows from here). */
export const BACKOFF_BASE_MS = 500;
/** Backoff ceiling — a read should never wait longer than this between retries. */
export const BACKOFF_CAP_MS = 8_000;
/** Upper bound on an honoured `Retry-After`, so a hostile/oversized value can't hang the client. */
export const RETRY_AFTER_CAP_MS = 60_000;

/**
 * Capped exponential backoff with jitter (attempt is 1-based): half the capped delay is fixed and half
 * is random, so concurrent clients don't synchronise (a thundering herd) yet never wait below half the
 * cap. `rand` is injectable for deterministic tests.
 */
export function backoffMs(
  attempt: number,
  rand: () => number = Math.random,
  base: number = BACKOFF_BASE_MS,
  cap: number = BACKOFF_CAP_MS,
): number {
  const capped = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(capped / 2 + rand() * (capped / 2));
}

/** Transient statuses worth a bounded retry on an idempotent request; every other status is terminal. */
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/**
 * Whether an HTTP status is a transient failure (throttle / gateway / unavailable / timeout). A 500 is
 * deliberately NOT retryable — it usually signals a deterministic server fault that a blind retry won't
 * cure, and retrying a non-idempotent write on a 500 risks a duplicate.
 */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/**
 * Parse a `Retry-After` header to a millisecond delay. Only the delta-seconds form is honoured (the
 * common case); an HTTP-date, absent, negative, or non-numeric value returns undefined so the caller
 * falls back to `backoffMs`. The result is clamped to `RETRY_AFTER_CAP_MS`.
 */
export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Math.min(RETRY_AFTER_CAP_MS, Number(trimmed) * 1000);
}
