import { describe, expect, it } from "vitest";

import {
  INGEST_STATEMENT_TIMEOUT_MS,
  WATERMARK_COMMIT_MARGIN_MS,
  WATERMARK_DELTA_MS,
  watermarkCutoff,
} from "./watermark";

describe("tunnel watermark", () => {
  it("keeps δ STRICTLY greater than the ingest statement_timeout (commit-visibility margin)", () => {
    // δ must exceed the statement_timeout by a positive margin. received_at is stamped at
    // transaction_timestamp (txn start); a row becomes visible to a concurrent reader only after
    // the INSERT statement (≤ statement_timeout) AND the commit's WAL flush + snapshot propagation
    // (ε > 0). If δ === statement_timeout, a slow (near-timeout) insert can become visible AFTER the
    // watermark cutoff already passed its received_at, letting a leapfrogging cursor skip it. The
    // margin closes that gap — the at-least-once tail guarantee depends on it.
    expect(WATERMARK_DELTA_MS).toBeGreaterThan(INGEST_STATEMENT_TIMEOUT_MS);
  });

  it("composes δ as statement_timeout + a positive commit-visibility margin", () => {
    expect(WATERMARK_COMMIT_MARGIN_MS).toBeGreaterThan(0);
    expect(WATERMARK_DELTA_MS).toBe(INGEST_STATEMENT_TIMEOUT_MS + WATERMARK_COMMIT_MARGIN_MS);
  });

  it("mirrors the migration's 5s ingest statement_timeout", () => {
    // Lockstep with packages/db/db/migrations/0006_ingest_event.sql.
    expect(INGEST_STATEMENT_TIMEOUT_MS).toBe(5_000);
  });

  it("cuts the durable tail back by δ", () => {
    const now = new Date("2026-06-12T20:00:10.000Z");
    expect(watermarkCutoff(now).getTime()).toBe(now.getTime() - WATERMARK_DELTA_MS);
  });
});
