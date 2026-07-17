import {
  DEDUP_STRATEGIES as SHARED_DEDUP,
  HTTP_METHODS as SHARED_METHODS,
} from "@webhook-co/shared";
import { describe, expect, it } from "vitest";

import { DEDUP_STRATEGIES, DEDUP_STRATEGY_LABELS, HTTP_METHODS } from "./event-facets";

// THE DRIFT GUARD for the client-local facet vocabularies. They are copied (not imported at runtime) to keep
// the shared barrel out of the browser bundle / off the Turbopack export-* trap — so this test, which runs in
// node where importing shared is free, is what keeps the copies honest against their source.
describe("event-facets mirrors the shared vocabularies", () => {
  it("HTTP_METHODS matches shared exactly, in order", () => {
    expect([...HTTP_METHODS]).toEqual([...SHARED_METHODS]);
  });

  it("DEDUP_STRATEGIES matches shared exactly, in order", () => {
    expect([...DEDUP_STRATEGIES]).toEqual([...SHARED_DEDUP]);
  });

  it("every dedup strategy has a human label (never a raw slug in the UI)", () => {
    for (const s of SHARED_DEDUP) {
      expect(DEDUP_STRATEGY_LABELS[s]).toBeTruthy();
      expect(DEDUP_STRATEGY_LABELS[s]).not.toBe(s); // a label, not the slug echoed back
    }
    // and no stale label for a strategy that no longer exists
    expect(Object.keys(DEDUP_STRATEGY_LABELS).sort()).toEqual([...SHARED_DEDUP].sort());
  });
});
