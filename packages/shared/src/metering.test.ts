import { describe, expect, it } from "vitest";

import { ingestAllowed, shouldPauseForCap, type IngestGuardSignal } from "./metering";

describe("ingestAllowed", () => {
  const base: IngestGuardSignal = { orgId: "o", paused: false, eventCap: 1000 };

  it("allows when not paused", () => {
    expect(ingestAllowed(base)).toBe(true);
  });

  it("blocks when paused", () => {
    expect(ingestAllowed({ ...base, paused: true })).toBe(false);
  });
});

describe("shouldPauseForCap (soft-cap)", () => {
  it("pauses at or over the cap under the 'pause' policy", () => {
    expect(shouldPauseForCap(999, 1000, "pause")).toBe(false);
    expect(shouldPauseForCap(1000, 1000, "pause")).toBe(true);
    expect(shouldPauseForCap(1001, 1000, "pause")).toBe(true);
  });

  it("never pauses under the 'allow' policy", () => {
    expect(shouldPauseForCap(5000, 1000, "allow")).toBe(false);
  });

  it("never pauses an uncapped org", () => {
    expect(shouldPauseForCap(1_000_000, null, "pause")).toBe(false);
  });
});
