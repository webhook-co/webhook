// Shared retry/backoff primitives for the CLI's two resilience surfaces: the `listen` tunnel reconnect
// loop and the api-client's bounded request retries. Kept pure + injectable (rand/sleep) so every caller
// is node-tested with no real timers or network. Error COPY lives with the callers (the hygiene tier is
// split: this is the retry LOGIC); the api-client decides WHICH requests are retry-safe.

/** Reconnect/backoff base (the first wait grows from here). */
export const BACKOFF_BASE_MS = 500;
/** Reconnect/backoff ceiling — the tunnel may wait up to this between reconnect attempts. */
export const BACKOFF_CAP_MS = 30_000;

/**
 * Capped exponential backoff with jitter (attempt is 1-based): half the capped delay is fixed and half
 * is random, so concurrent clients don't synchronise (a thundering herd) yet never wait below half the
 * cap. `base`/`cap` default to the tunnel reconnect bounds; the api-client passes a shorter cap.
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

/** A backoff wait that resolves immediately on abort, so Ctrl-C isn't delayed by a pending sleep. */
export function abortableSleep(
  signal: AbortSignal,
  sleep: (ms: number) => Promise<void>,
  ms: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    void sleep(ms).then(finish);
  });
}

/** Per-request wall-clock budget before the api-client aborts and (if idempotent) retries. */
export const API_TIMEOUT_MS = 30_000;
/** Total api-client attempts per request (1 initial + 2 retries) before surfacing the failure. */
export const API_MAX_ATTEMPTS = 3;
/** A shorter backoff ceiling for api retries — a read should never wait the 30s tunnel cap. */
export const API_RETRY_CAP_MS = 8_000;
/** Upper bound on an honoured `Retry-After`, so a hostile/oversized value can't hang the CLI. */
export const RETRY_AFTER_CAP_MS = 60_000;

/** Capped exponential backoff for an api retry (shorter ceiling than the tunnel reconnect). */
export function apiBackoffMs(attempt: number, rand: () => number = Math.random): number {
  return backoffMs(attempt, rand, BACKOFF_BASE_MS, API_RETRY_CAP_MS);
}

/** Transient statuses worth a bounded retry on an idempotent request; every other status is terminal. */
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/** Whether an HTTP status is a transient failure (throttle / gateway / unavailable / timeout). */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/**
 * Parse a `Retry-After` header to a millisecond delay. Only the delta-seconds form is honoured (the
 * common case); an HTTP-date, an absent, negative, or non-numeric value returns undefined so the caller
 * falls back to `apiBackoffMs`. The result is clamped to `RETRY_AFTER_CAP_MS`.
 */
export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds)) return undefined;
  return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
}
