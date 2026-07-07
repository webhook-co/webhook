// Tunnel safety-lag watermark constants. The durable resume scan only
// returns rows with received_at <= now() - δ, where δ = the ingest statement_timeout PLUS a
// commit-visibility margin. A row's received_at is stamped at transaction_timestamp (txn start);
// the row becomes visible to a concurrent reader only after (a) the INSERT statement completes
// (bounded by statement_timeout) AND (b) the commit's WAL flush + snapshot propagation to the
// read path (ε > 0, incl. any Neon/Hyperdrive read-replica lag). δ must cover BOTH so that once a
// reader's cutoff (now() - δ) passes a timestamp, no row with a received_at at/below it can still
// become newly visible — otherwise a leapfrogging cursor would skip that late-visible row. Setting
// δ = statement_timeout alone leaves ε unaccounted; the margin below closes it, keeping the durable
// tail provably gapless (and the trigger tail's at-least-once guarantee honest).

/**
 * The ingest role's statement_timeout, in ms. MUST stay in lockstep with the
 * `alter role webhook_ingest set statement_timeout` value in
 * packages/db/db/migrations/0006_ingest_event.sql. A db test reads the live role
 * config; keep both at the same value.
 */
export const INGEST_STATEMENT_TIMEOUT_MS = 5_000;

/**
 * Commit-visibility margin (ms) added on top of the statement_timeout to form δ. Covers the ε
 * budget — WAL commit flush + snapshot/read-replica visibility lag — between a row's received_at
 * stamp (txn start) and that row becoming visible to a concurrent tail reader. Must be > 0: it is
 * the load-bearing gap between "statement finished" and "row visible" that the gapless proof needs.
 * Cost of a larger value: a proportionally higher steady-state tail latency floor (δ). 1s comfortably
 * covers a WAL flush plus a Neon/Hyperdrive read-path lag while adding only ~1s to that floor.
 */
export const WATERMARK_COMMIT_MARGIN_MS = 1_000;

/**
 * The watermark delta δ = ingest statement_timeout + the commit-visibility margin. STRICTLY greater
 * than the statement_timeout (the margin is load-bearing — see above). Asserted in watermark.test.ts.
 */
export const WATERMARK_DELTA_MS = INGEST_STATEMENT_TIMEOUT_MS + WATERMARK_COMMIT_MARGIN_MS;

/** The newest received_at a durable tail/cursor may return: now - δ. */
export function watermarkCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - WATERMARK_DELTA_MS);
}
