// The outbound-delivery retry schedule (S3 Slice 3). A delivery is attempted up to DELIVERY_MAX_ATTEMPTS
// times; after a failed attempt N (1-based), the engine waits nextRetryDelayMs(N) before attempt N+1, and
// dead-letters once attempts are exhausted. The curve is a FIXED exponential schedule (attempt 1 is the
// immediate first delivery; the 7 inter-attempt delays below cover attempts 1..7), with bounded random
// jitter so a fleet of deliveries to a recovering host don't re-fire in lockstep (a thundering herd). Pure
// + injectable-jitter so the schedule is exhaustively unit-testable; the per-attempt clock is owned by the
// per-destination delivery DO's alarm.

/** Total delivery attempts before a delivery is dead-lettered. */
export const DELIVERY_MAX_ATTEMPTS = 8;

/** Fraction of the base delay used as the symmetric jitter band (±10%). */
const JITTER_FRACTION = 0.1;

/**
 * The fixed inter-attempt delays in ms, indexed by (attempt - 1): the wait after attempt 1 is 5s, after
 * attempt 2 is 5m, ... after attempt 7 is 10h. There is no entry after attempt 8 — that failure exhausts.
 */
const RETRY_DELAYS_MS: readonly number[] = [
  5_000, // after attempt 1 → 5 seconds
  5 * 60_000, // 5 minutes
  30 * 60_000, // 30 minutes
  2 * 60 * 60_000, // 2 hours
  5 * 60 * 60_000, // 5 hours
  10 * 60 * 60_000, // 10 hours
  10 * 60 * 60_000, // 10 hours
];

/**
 * The delay (ms) to wait before the next attempt, given the attempt that just FAILED (1-based), or null
 * when attempts are exhausted (attempt >= DELIVERY_MAX_ATTEMPTS) — the caller dead-letters on null. A
 * non-positive attempt is defensive and also yields null. `jitter` returns [0,1) (defaults to Math.random);
 * the result is the base delay ± JITTER_FRACTION, clamped to be non-negative.
 */
export function nextRetryDelayMs(
  attempt: number,
  jitter: () => number = Math.random,
): number | null {
  if (attempt < 1 || attempt >= DELIVERY_MAX_ATTEMPTS) return null;
  const base = RETRY_DELAYS_MS[attempt - 1]!;
  const delta = base * JITTER_FRACTION * (jitter() * 2 - 1);
  return Math.max(0, Math.round(base + delta));
}
