import { describe, expect, it } from "vitest";

import { INGEST_STATEMENT_TIMEOUT_MS, WATERMARK_DELTA_MS, watermarkCutoff } from "./watermark";

describe("tunnel watermark (H5)", () => {
  it("keeps δ >= the ingest statement_timeout (gapless invariant)", () => {
    expect(WATERMARK_DELTA_MS).toBeGreaterThanOrEqual(INGEST_STATEMENT_TIMEOUT_MS);
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
