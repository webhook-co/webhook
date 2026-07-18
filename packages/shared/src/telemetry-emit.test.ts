import { describe, expect, test } from "vitest";

import { metricDataPoint } from "./telemetry-emit";

describe("metricDataPoint", () => {
  test("maps a metric + bounded labels to an AE data point: index=name, blobs=label values in declared order", () => {
    // ingest.requests declares labels [outcome, method, verified] (that order)
    const dp = metricDataPoint("ingest.requests", {
      verified: "true",
      outcome: "captured",
      method: "POST",
    });
    expect(dp.indexes).toEqual(["ingest.requests"]); // the metric name is the AE index (bounded, sampling key)
    expect(dp.blobs).toEqual(["captured", "POST", "true"]); // DECLARED order, not call order
    expect(dp.doubles).toEqual([1]); // a counter defaults to 1
  });

  test("carries the measured value for a distribution (e.g. duration)", () => {
    const dp = metricDataPoint("ingest.duration_ms", { outcome: "captured" }, 42.5);
    expect(dp.indexes).toEqual(["ingest.duration_ms"]);
    expect(dp.blobs).toEqual(["captured"]);
    expect(dp.doubles).toEqual([42.5]);
  });

  test("rejects an undeclared metric (reuses the catalog guard)", () => {
    expect(() => metricDataPoint("not.a.metric" as never, { outcome: "x" })).toThrow(
      /unknown metric/i,
    );
  });

  test("rejects an undeclared label key for the metric", () => {
    expect(() => metricDataPoint("ingest.duration_ms", { method: "POST" })).toThrow(/label/i);
  });

  test("rejects an id/PII-shaped label value (the cardinality bomb)", () => {
    expect(() =>
      metricDataPoint("ingest.requests", {
        outcome: "550e8400-e29b-41d4-a716-446655440000",
        method: "POST",
        verified: "true",
      }),
    ).toThrow(/id-shaped|cardinality/i);
  });

  test("requires every DECLARED label to be provided (a missing dimension is a bug, not an empty blob)", () => {
    // ingest.requests declares outcome+method+verified; omit verified
    expect(() =>
      metricDataPoint("ingest.requests", { outcome: "captured", method: "POST" }),
    ).toThrow(/requires label "verified"/i);
  });
});
