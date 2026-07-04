import { describe, expect, it } from "vitest";

import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  RETRY_AFTER_CAP_MS,
  backoffMs,
  isRetryableStatus,
  parseRetryAfter,
} from "./retry.js";

describe("backoffMs", () => {
  it("returns half the capped delay when jitter is zero (never waits below half)", () => {
    expect(backoffMs(1, () => 0)).toBe(BACKOFF_BASE_MS / 2);
  });

  it("returns the full capped delay when jitter is maximal", () => {
    expect(backoffMs(1, () => 1)).toBe(BACKOFF_BASE_MS);
  });

  it("grows exponentially with the attempt number", () => {
    // attempt 2 → base*2 window ⇒ [base, 2*base]; with zero jitter that is `base`.
    expect(backoffMs(2, () => 0)).toBe(BACKOFF_BASE_MS);
  });

  it("never exceeds the cap", () => {
    expect(backoffMs(50, () => 1)).toBe(BACKOFF_CAP_MS);
    expect(backoffMs(50, () => 0)).toBe(BACKOFF_CAP_MS / 2);
  });
});

describe("isRetryableStatus", () => {
  it("is true for transient throttle/gateway/unavailable/timeout statuses", () => {
    for (const s of [429, 502, 503, 504]) expect(isRetryableStatus(s)).toBe(true);
  });

  it("is false for terminal statuses (incl. 500, which won't self-heal on blind retry)", () => {
    for (const s of [200, 400, 401, 403, 404, 409, 500]) expect(isRetryableStatus(s)).toBe(false);
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds to milliseconds", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("trims surrounding whitespace", () => {
    expect(parseRetryAfter("  3  ")).toBe(3000);
  });

  it("clamps an oversized value to the cap", () => {
    expect(parseRetryAfter("99999")).toBe(RETRY_AFTER_CAP_MS);
  });

  it("returns undefined for a null, non-numeric, negative, or HTTP-date value", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter("-1")).toBeUndefined();
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT")).toBeUndefined();
  });
});
