// The bounded metric catalog (ADR-0125), typed for runtime use. The JSON is the single source of truth
// — the CI guard (scripts/telemetry-label-guard.mjs) parses the SAME file — so a metric or label added
// in one place is enforced in the other. `assertBoundedMetricLabels` is the runtime defense: it refuses
// an undeclared metric, an undeclared label key, or an obvious id/PII-shaped label VALUE. The PRIMARY
// bound is the label-KEY allowlist (a tenant/event id can't be a label key); the value check is a
// backstop that catches the obvious shapes (uuid/email/IP/opaque token) an emit-site bug might pass.

import catalog from "./telemetry-catalog.json";

/** The kind of a metric — mirrors how it lands in Analytics Engine (counter/gauge → doubles, distribution → a value column). */
export type MetricKind = "counter" | "gauge" | "distribution";

/** A single metric's contract: its kind, help text, and the exact (bounded) label keys it may carry. */
export interface MetricDefinition {
  readonly kind: MetricKind;
  readonly help: string;
  readonly labels: readonly string[];
}

/** The permitted label KEYS across all metrics — every metric's labels are a subset of this. */
export const METRIC_LABEL_ALLOWLIST: ReadonlySet<string> = new Set(catalog.labelAllowlist);

const METRIC_KINDS: ReadonlySet<string> = new Set<MetricKind>(["counter", "gauge", "distribution"]);

/** Narrow a raw JSON metric to a typed MetricDefinition, throwing on an invalid kind — so the JSON
 *  import (which widens `kind` to `string`) is narrowed by a runtime check, not an unchecked cast. */
function toMetricDefinition(
  name: string,
  raw: { kind: string; help: string; labels: string[] },
): MetricDefinition {
  if (!METRIC_KINDS.has(raw.kind)) {
    throw new Error(`telemetry-catalog: metric "${name}" has invalid kind "${raw.kind}"`);
  }
  return { kind: raw.kind as MetricKind, help: raw.help, labels: raw.labels };
}

/** The declared metrics, keyed by metric name (kinds validated at load). */
export const TELEMETRY_METRICS: Readonly<Record<string, MetricDefinition>> = Object.fromEntries(
  Object.entries(catalog.metrics).map(([name, raw]) => [name, toMetricDefinition(name, raw)]),
);

/**
 * An OBVIOUSLY id/PII-shaped label VALUE — a uuid, an email (`@`), a dotted-quad IP, or a 20+-char
 * CONTIGUOUS opaque run (no separators — so a long descriptive snake_case enum/job value like
 * `delivery_stats_rollup` is exempt, while a dashless uuid or base62 token is caught). Deliberately
 * conservative: a prefixed `[a-z]+_…` heuristic was removed because it both missed short ids (`org_1`)
 * AND false-flagged legit snake_case enum values (`webhook_reaper`). This is
 * only a backstop — the primary control is the strict label-KEY allowlist (a tenant id can't be a label
 * key), so a short id slipping through as a value still requires an emit-site bug shoving it into a
 * bounded enum. Passing an obvious id/PII value is a cardinality/cost bomb, so it throws.
 */
const ID_SHAPED_VALUE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|@|^\d{1,3}(?:\.\d{1,3}){3}$|^[A-Za-z0-9]{20,}$/i;

/**
 * Assert that a metric write carries only labels declared for that metric, with bounded values. Throws
 * on an unknown metric, an undeclared label key, or an id-shaped label value. Call it at every emit site
 * so an unbounded label can never reach Analytics Engine.
 */
export function assertBoundedMetricLabels(
  metric: string,
  labels: Readonly<Record<string, string>>,
): void {
  const def = TELEMETRY_METRICS[metric];
  if (def === undefined) {
    throw new Error(`telemetry: unknown metric "${metric}" (declare it in telemetry-catalog.json)`);
  }
  const declared = new Set(def.labels);
  for (const [key, value] of Object.entries(labels)) {
    if (!declared.has(key)) {
      throw new Error(`telemetry: metric "${metric}" does not declare label "${key}"`);
    }
    if (ID_SHAPED_VALUE.test(value)) {
      throw new Error(
        `telemetry: id-shaped value for label "${key}" on "${metric}" — that is a cardinality bomb; use a bounded enum`,
      );
    }
  }
}
