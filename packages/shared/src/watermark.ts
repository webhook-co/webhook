// Tunnel safety-lag watermark constants (§0.10, H5). The durable resume scan only
// returns rows with received_at <= now() - δ, where δ >= the ingest statement_timeout.
// Because an in-flight ingest can't commit a row with a received_at older than its own
// statement_timeout window, no row can appear behind a cursor that has passed the
// watermark — so the durable tail is provably gapless.

/**
 * The ingest role's statement_timeout, in ms. MUST stay in lockstep with the
 * `alter role webhook_ingest set statement_timeout` value in
 * packages/db/db/migrations/0006_ingest_event.sql. A db test reads the live role
 * config; keep both at the same value.
 */
export const INGEST_STATEMENT_TIMEOUT_MS = 5_000;

/**
 * The watermark delta δ. Must be >= INGEST_STATEMENT_TIMEOUT_MS. Kept equal: the
 * tightest gapless watermark that still satisfies the invariant.
 */
export const WATERMARK_DELTA_MS = INGEST_STATEMENT_TIMEOUT_MS;

if (WATERMARK_DELTA_MS < INGEST_STATEMENT_TIMEOUT_MS) {
  // Compile-time-ish invariant guard (also asserted in tests): δ >= statement_timeout.
  throw new Error("WATERMARK_DELTA_MS must be >= INGEST_STATEMENT_TIMEOUT_MS");
}

/** The newest received_at a durable tail/cursor may return: now - δ. */
export function watermarkCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - WATERMARK_DELTA_MS);
}
