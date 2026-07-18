// The bounded metric catalog (ADR-0125). A TYPED TS literal — NOT a JSON import — so it is portable
// across every consumer (workerd/esbuild, Turbopack, vitest, Bun, and Node's native ESM, which rejects
// a bare `import … from "*.json"` without an import attribute; the shared barrel is imported through
// exactly that non-bundler path in the web e2e). The type system enforces the core invariant — every
// metric's labels are a subset of METRIC_LABEL_KEYS at COMPILE TIME — and `catalogViolations` covers the
// semantic checks the types can't (no id-shaped label key; a non-empty floor). `assertBoundedMetricLabels`
// is the runtime defense at emit sites: it refuses an undeclared metric/label or an obvious id/PII-shaped
// label value, so a tenant/event id can't be smuggled into a label and explode the series count (and bill).

/** The kind of a metric — mirrors how it lands in Analytics Engine (counter/gauge → doubles, distribution → a value column). */
export type MetricKind = "counter" | "gauge" | "distribution";

/**
 * The permitted label KEYS across all metrics — bounded enums only. The single source of truth: the
 * `MetricLabelKey` type below binds every metric's labels to this list at compile time, so an
 * off-allowlist label is a tsc error, not a runtime surprise.
 */
export const METRIC_LABEL_KEYS = [
  "outcome",
  "method",
  "verified",
  "status_class",
  "attempt_bucket",
  "result",
  "job",
] as const;

/** A label key that is on the allowlist (compile-time bound). */
export type MetricLabelKey = (typeof METRIC_LABEL_KEYS)[number];

/** The permitted label keys as a set (runtime membership checks). */
export const METRIC_LABEL_ALLOWLIST: ReadonlySet<string> = new Set(METRIC_LABEL_KEYS);

/** A single metric's contract: its kind, help text, and the exact (bounded) label keys it may carry. */
export interface MetricDefinition {
  readonly kind: MetricKind;
  readonly help: string;
  /** Bounded to {@link METRIC_LABEL_KEYS} at compile time — an off-allowlist label fails typecheck. */
  readonly labels: readonly MetricLabelKey[];
}

/**
 * The declared metrics, keyed by metric name. `satisfies` keeps each entry's precise literal types while
 * enforcing the MetricDefinition shape — so a bad `kind` or an off-allowlist `label` is a compile error.
 * Slice 3 wires emission to these names; this literal is the contract.
 */
export const TELEMETRY_METRICS = {
  "ingest.requests": {
    kind: "counter",
    help: "Ingest requests by outcome (rate + errors).",
    labels: ["outcome", "method", "verified"],
  },
  "ingest.duration_ms": {
    kind: "distribution",
    help: "Worker-internal ingest ACK-budget duration.",
    labels: ["outcome"],
  },
  "delivery.attempts": {
    kind: "counter",
    help: "Outbound delivery attempts by response class and attempt bucket.",
    labels: ["status_class", "attempt_bucket"],
  },
  "delivery.duration_ms": {
    kind: "distribution",
    help: "Outbound delivery attempt duration by response class.",
    labels: ["status_class"],
  },
  "delivery.retries": {
    kind: "counter",
    help: "Outbound delivery retries scheduled by response class.",
    labels: ["status_class"],
  },
  "delivery.backlog": {
    kind: "gauge",
    help: "Due-but-undelivered backlog (DO-alarm saturation).",
    labels: [],
  },
  "cron.runs": {
    kind: "counter",
    help: "Scheduled cron/job runs by job and result.",
    labels: ["job", "result"],
  },
  "cron.duration_ms": {
    kind: "distribution",
    help: "Scheduled cron/job duration by job.",
    labels: ["job"],
  },
} satisfies Record<string, MetricDefinition>;

/** A declared metric name. */
export type MetricName = keyof typeof TELEMETRY_METRICS;

/**
 * An OBVIOUSLY id/PII-shaped label VALUE — a uuid, an email (`@`), a dotted-quad IP, or a 20+-char
 * CONTIGUOUS opaque run (no separators — so a long descriptive snake_case enum/job value like
 * `delivery_stats_rollup` is exempt, while a dashless uuid or base62 token is caught). Deliberately
 * conservative: a prefixed `[a-z]+_…` heuristic was removed because it both missed short ids (`org_1`)
 * AND false-flagged legit snake_case enum values (`webhook_reaper`). This is only a backstop — the
 * primary bound is the label-KEY allowlist (a tenant id can't be a label key), so a short id slipping
 * through as a value still requires an emit-site bug shoving it into a bounded enum. Passing an obvious
 * id/PII value is a cardinality/cost bomb, so it throws.
 */
const ID_SHAPED_VALUE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|@|^\d{1,3}(?:\.\d{1,3}){3}$|^[A-Za-z0-9]{20,}$/i;

/**
 * A label KEY that names an identifier or PII/high-cardinality field — id / org / tenant / endpoint /
 * event / user / url / ip / addr / host / path / slug / session / signature / phone / device / hash /
 * fingerprint / name / email / secret / password / apikey, etc. Bounded enum keys (outcome, method,
 * verified, status_class, attempt_bucket, result, job) never match. Used by {@link catalogViolations} as
 * a backstop over the allowlist itself — the primary bound is the compile-time `MetricLabelKey` type.
 */
const ID_SHAPED_KEY =
  /(^|[._-])(id|ids|org|orgs|tenant|tenants|endpoint|endpoints|event|events|user|users|key|keys|token|tokens|url|urls|email|emails|uuid|correlation|delivery|customer|account|ip|ips|addr|host|hosts|path|paths|slug|slugs|session|sessions|sig|signature|signatures|phone|phones|device|devices|hash|fingerprint|name|secret|secrets|password|passwords|apikey|apikeys)([._-]|$)/i;

/**
 * Assert that a metric write carries only labels declared for that metric, with bounded values. Throws
 * on an unknown metric, an undeclared label key, or an id-shaped label value. Call it at every emit site
 * so an unbounded label can never reach Analytics Engine.
 */
export function assertBoundedMetricLabels(
  metric: string,
  labels: Readonly<Record<string, string>>,
): void {
  const def = (TELEMETRY_METRICS as Record<string, MetricDefinition>)[metric];
  if (def === undefined) {
    throw new Error(`telemetry: unknown metric "${metric}" (declare it in telemetry-catalog.ts)`);
  }
  const declared = new Set<string>(def.labels);
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

/**
 * Validate a catalog's structural + semantic invariants — the enforcement CI runs (via the test suite),
 * replacing a standalone parse-based guard. Takes `unknown` so a crafted/malformed catalog is checked
 * defensively; returns [] when clean. Floor: an empty/absent allowlist or metrics set is a violation, so
 * "never checked" cannot read as "passed". The real catalog is fed as `{ labelAllowlist, metrics }`.
 */
export function catalogViolations(catalog: unknown): string[] {
  const violations: string[] = [];
  if (catalog === null || typeof catalog !== "object") {
    return ["catalog is absent or not an object"];
  }
  const { labelAllowlist, metrics } = catalog as {
    labelAllowlist?: unknown;
    metrics?: unknown;
  };

  if (!Array.isArray(labelAllowlist) || labelAllowlist.length === 0) {
    violations.push("labelAllowlist is empty or absent");
  }
  if (
    metrics === null ||
    typeof metrics !== "object" ||
    Object.keys((metrics as Record<string, unknown>) ?? {}).length === 0
  ) {
    violations.push("metrics is empty or absent");
  }

  const allowed = new Set<string>(
    Array.isArray(labelAllowlist) ? (labelAllowlist as string[]) : [],
  );
  for (const key of allowed) {
    if (ID_SHAPED_KEY.test(key)) {
      violations.push(`labelAllowlist contains id-shaped key "${key}" (unbounded cardinality)`);
    }
  }

  for (const [name, def] of Object.entries(
    (metrics as Record<string, { labels?: unknown }>) ?? {},
  )) {
    const labels = def?.labels;
    if (!Array.isArray(labels)) {
      violations.push(`metric "${name}" has no labels array`);
      continue;
    }
    for (const label of labels as string[]) {
      if (ID_SHAPED_KEY.test(label)) {
        violations.push(`metric "${name}" declares id-shaped label "${label}" (cardinality bomb)`);
      }
      if (!allowed.has(label)) {
        violations.push(`metric "${name}" declares label "${label}" not in labelAllowlist`);
      }
    }
  }
  return violations;
}
