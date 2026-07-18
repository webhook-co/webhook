// The metric emit boundary (ADR-0124/0125). Maps a bounded catalog metric to a Cloudflare Analytics
// Engine data point and (optionally) writes it. Every emission runs through assertBoundedMetricLabels, so
// an unbounded / id-shaped label can never reach AE. `metricDataPoint` is pure so the mapping is unit-
// tested without a real dataset; `emitMetric` is the thin write. (AnalyticsEngineDataPoint/Dataset are
// ambient workers-types — TYPES only, erased at runtime — so this stays safe in the shared barrel that the
// Next.js/Turbopack apps import.)

import { assertBoundedMetricLabels, TELEMETRY_METRICS, type MetricName } from "./telemetry-catalog";

/**
 * Map a catalog metric + its bounded labels (+ an optional numeric value) to an Analytics Engine data
 * point: the metric NAME is the single index (a low-cardinality sampling key), the label values become
 * blobs in the metric's DECLARED order (stable for querying), and the value is the double (a counter
 * defaults to 1; a distribution passes the measured value). Throws — via the catalog guard — on an
 * unknown metric, an undeclared / id-shaped label, or a MISSING declared label (a dropped dimension is a
 * bug, not an empty blob).
 */
export function metricDataPoint(
  metric: MetricName,
  labels: Readonly<Record<string, string>>,
  value = 1,
): AnalyticsEngineDataPoint {
  assertBoundedMetricLabels(metric, labels);
  const def = TELEMETRY_METRICS[metric];
  const blobs = def.labels.map((key) => {
    const v = labels[key];
    if (v === undefined) {
      throw new Error(`telemetry: metric "${metric}" requires label "${key}"`);
    }
    return v;
  });
  return { indexes: [metric], blobs, doubles: [value] };
}

/**
 * Write one metric data point to the AE dataset. Best-effort: telemetry is non-critical, so callers
 * invoke this off the response-critical path (or tolerate a throw) — it never gates a request.
 */
export function emitMetric(
  dataset: AnalyticsEngineDataset,
  metric: MetricName,
  labels: Readonly<Record<string, string>>,
  value = 1,
): void {
  dataset.writeDataPoint(metricDataPoint(metric, labels, value));
}
