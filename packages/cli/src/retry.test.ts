import { describe, expect, it } from "vitest";

import {
  abortableSleep,
  apiBackoffMs,
  backoffMs,
  isRetryableStatus,
  parseRetryAfter,
  RETRY_AFTER_CAP_MS,
} from "./retry.js";

describe("backoffMs", () => {
  it("caps the exponential growth and applies jitter (default base 500 / cap 30000)", () => {
    expect(backoffMs(1, () => 0)).toBe(250); // base 500 → half 250 + 0 jitter
    expect(backoffMs(1, () => 1)).toBe(500); // 250 + 250
    expect(backoffMs(50, () => 0)).toBe(15000); // capped at 30000 → half
    expect(backoffMs(50, () => 1)).toBe(30000);
  });

  it("honours an overridden base + cap", () => {
    expect(backoffMs(1, () => 0, 100, 1000)).toBe(50); // base 100 → half
    expect(backoffMs(20, () => 1, 100, 1000)).toBe(1000); // capped at 1000 → half + half
  });
});

describe("apiBackoffMs", () => {
  it("uses the shorter api cap so a request never waits the 30s tunnel cap", () => {
    // Capped well below the listen reconnect cap (30000); a deep attempt saturates the api cap.
    expect(apiBackoffMs(1, () => 0)).toBe(250); // base 500 → half
    expect(apiBackoffMs(50, () => 1)).toBeLessThanOrEqual(8000);
    expect(apiBackoffMs(50, () => 1)).toBeGreaterThan(0);
  });
});

describe("isRetryableStatus", () => {
  it("retries only transient server/throttle statuses", () => {
    for (const s of [429, 502, 503, 504]) expect(isRetryableStatus(s)).toBe(true);
    for (const s of [200, 400, 401, 403, 404, 409, 500, 501])
      expect(isRetryableStatus(s)).toBe(false);
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds into milliseconds", () => {
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter("30")).toBe(30000);
  });

  it("caps an oversized Retry-After so the CLI never hangs for minutes", () => {
    expect(parseRetryAfter("99999")).toBe(RETRY_AFTER_CAP_MS);
  });

  it("returns undefined for absent, non-numeric, negative, or HTTP-date values (falls back to backoff)", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter("-5")).toBeUndefined();
    expect(parseRetryAfter("Wed, 21 Oct 2099 07:28:00 GMT")).toBeUndefined();
  });
});

describe("abortableSleep", () => {
  it("resolves immediately when the signal is already aborted, without sleeping", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let slept = false;
    await abortableSleep(
      ctrl.signal,
      async () => {
        slept = true;
      },
      100,
    );
    expect(slept).toBe(false);
  });

  it("sleeps the requested duration when not aborted", async () => {
    const ctrl = new AbortController();
    let sleptMs = -1;
    await abortableSleep(
      ctrl.signal,
      async (ms) => {
        sleptMs = ms;
      },
      50,
    );
    expect(sleptMs).toBe(50);
  });

  it("resolves immediately when aborted mid-sleep (Ctrl-C isn't delayed)", async () => {
    const ctrl = new AbortController();
    const pending = abortableSleep(ctrl.signal, () => new Promise<void>(() => {}), 10_000);
    ctrl.abort();
    await expect(pending).resolves.toBeUndefined();
  });
});
