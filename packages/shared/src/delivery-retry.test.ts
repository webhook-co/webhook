import { describe, expect, it } from "vitest";

import { DELIVERY_MAX_ATTEMPTS, nextRetryDelayMs } from "./delivery-retry";

// The fixed exponential retry schedule for outbound delivery (S3 Slice 3). 8 attempts total; the 7
// inter-attempt delays after attempts 1..7 are 5s, 5m, 30m, 2h, 5h, 10h, 10h; attempt 8's failure
// exhausts (→ dead-letter). Jitter is injected so the schedule is deterministic under test.

const noJitter = () => 0.5; // jitter()*2-1 = 0 → exactly the base delay
const S = 1000;
const M = 60 * S;
const H = 60 * M;
const EXPECTED_BASE_MS = [5 * S, 5 * M, 30 * M, 2 * H, 5 * H, 10 * H, 10 * H];

describe("nextRetryDelayMs", () => {
  it("returns the fixed exponential base delay after each of attempts 1..7 (no jitter)", () => {
    for (let attempt = 1; attempt <= 7; attempt++) {
      expect(nextRetryDelayMs(attempt, noJitter)).toBe(EXPECTED_BASE_MS[attempt - 1]);
    }
  });

  it("exhausts after the 8th attempt (and beyond) → null (dead-letter)", () => {
    expect(nextRetryDelayMs(DELIVERY_MAX_ATTEMPTS, noJitter)).toBeNull(); // attempt 8 failed
    expect(nextRetryDelayMs(8, noJitter)).toBeNull();
    expect(nextRetryDelayMs(99, noJitter)).toBeNull();
  });

  it("guards a non-positive attempt (defensive → null)", () => {
    expect(nextRetryDelayMs(0, noJitter)).toBeNull();
    expect(nextRetryDelayMs(-1, noJitter)).toBeNull();
  });

  it("applies bounded ±10% jitter around the base (never negative, within band)", () => {
    // jitter at the extremes: 0 → -10%, ~1 → +10%
    expect(nextRetryDelayMs(1, () => 0)).toBe(Math.round(5 * S * 0.9));
    expect(nextRetryDelayMs(1, () => 1)).toBe(Math.round(5 * S * 1.1));
    // a real random jitter stays strictly within [90%, 110%] of base for every attempt
    for (let attempt = 1; attempt <= 7; attempt++) {
      const base = EXPECTED_BASE_MS[attempt - 1]!;
      for (let i = 0; i < 50; i++) {
        const d = nextRetryDelayMs(attempt)!;
        expect(d).toBeGreaterThanOrEqual(Math.floor(base * 0.9));
        expect(d).toBeLessThanOrEqual(Math.ceil(base * 1.1));
      }
    }
  });

  it("DELIVERY_MAX_ATTEMPTS is 8 (the documented ceiling)", () => {
    expect(DELIVERY_MAX_ATTEMPTS).toBe(8);
  });
});
