import { describe, expect, test } from "vitest";

import {
  assertBoundedMetricLabels,
  catalogViolations,
  METRIC_LABEL_ALLOWLIST,
  METRIC_LABEL_KEYS,
  TELEMETRY_METRICS,
} from "./telemetry-catalog";

// The whole catalog as the guard consumes it — this is the check running against the real contract.
const REAL_CATALOG = { labelAllowlist: METRIC_LABEL_KEYS, metrics: TELEMETRY_METRICS };

describe("the metric catalog", () => {
  test("every declared metric's labels are a subset of the allowlist (bounded cardinality)", () => {
    for (const [name, def] of Object.entries(TELEMETRY_METRICS)) {
      for (const label of def.labels) {
        expect(
          METRIC_LABEL_ALLOWLIST.has(label),
          `${name} declares off-allowlist label ${label}`,
        ).toBe(true);
      }
    }
  });
});

describe("catalogViolations (the enforcement CI runs)", () => {
  test("the real committed catalog validates clean", () => {
    expect(catalogViolations(REAL_CATALOG)).toEqual([]);
  });

  test("an empty/absent catalog is a violation (zero-input floor)", () => {
    expect(catalogViolations({}).length).toBeGreaterThan(0);
    expect(catalogViolations({ labelAllowlist: [], metrics: {} }).length).toBeGreaterThan(0);
    expect(catalogViolations(null).length).toBeGreaterThan(0);
  });

  test("a metric declaring an id-shaped label key is a violation", () => {
    const violations = catalogViolations({
      labelAllowlist: ["outcome", "org_id"],
      metrics: { "ingest.requests": { kind: "counter", help: "x", labels: ["org_id"] } },
    });
    expect(violations.some((v) => v.includes("org_id"))).toBe(true);
  });

  test("an ip / path / host / session label key is caught by the extended id-shape denylist", () => {
    for (const idKey of ["client_ip", "request_path", "host", "session_id"]) {
      const violations = catalogViolations({
        labelAllowlist: ["outcome", idKey],
        metrics: { "ingest.requests": { kind: "counter", help: "x", labels: [idKey] } },
      });
      expect(
        violations.some((v) => v.includes(idKey)),
        `expected a violation for ${idKey}`,
      ).toBe(true);
    }
  });

  test("a metric with a missing/non-array labels is a violation (fail closed, no throw)", () => {
    const violations = catalogViolations({
      labelAllowlist: ["outcome"],
      metrics: { "ingest.requests": { kind: "counter", help: "x" } },
    });
    expect(violations.some((v) => /no labels array/.test(v))).toBe(true);
  });

  test("a metric label outside the allowlist is a violation", () => {
    const violations = catalogViolations({
      labelAllowlist: ["outcome"],
      metrics: { "ingest.requests": { kind: "counter", help: "x", labels: ["method"] } },
    });
    expect(violations.some((v) => v.includes("method"))).toBe(true);
  });
});

describe("assertBoundedMetricLabels", () => {
  test("accepts labels declared for the metric", () => {
    expect(() =>
      assertBoundedMetricLabels("ingest.requests", { outcome: "captured", method: "POST" }),
    ).not.toThrow();
  });

  test("throws on an undeclared metric name (an undeclared metric is a bug, not a silent write)", () => {
    expect(() => assertBoundedMetricLabels("ingest.not_a_metric", { outcome: "x" })).toThrow(
      /unknown metric/i,
    );
  });

  test("throws when a label key is not declared for that metric", () => {
    // status_class is a real allowlist label, but ingest.requests does not declare it
    expect(() => assertBoundedMetricLabels("ingest.requests", { status_class: "2xx" })).toThrow(
      /label/i,
    );
  });

  test("throws on an id-shaped label VALUE (a tenant/event id smuggled into an enum label)", () => {
    expect(() =>
      assertBoundedMetricLabels("ingest.requests", {
        outcome: "550e8400-e29b-41d4-a716-446655440000",
      }),
    ).toThrow(/id-shaped|cardinality/i);
  });

  test("throws on an email or IP label VALUE (PII / high cardinality)", () => {
    expect(() =>
      assertBoundedMetricLabels("ingest.requests", { outcome: "user@example.com" }),
    ).toThrow(/id-shaped|cardinality/i);
    expect(() => assertBoundedMetricLabels("ingest.requests", { outcome: "192.168.1.1" })).toThrow(
      /id-shaped|cardinality/i,
    );
  });

  test("throws on a contiguous opaque token value (pins the opaque-run branch on its own)", () => {
    // a value that ONLY the opaque-run alternative catches (not uuid/email/ip) — a 22-char contiguous token
    expect(() =>
      assertBoundedMetricLabels("ingest.requests", { outcome: "aB3xK9mZ2qL7wR4tP1nY6d" }),
    ).toThrow(/id-shaped|cardinality/i);
  });

  test("does NOT throw on a legit long snake_case enum value (a job name past 20 chars)", () => {
    // cron.runs declares `job`; real job names are long snake_case (`delivery_stats_rollup` = 21) and
    // must not be flagged — the opaque-run check requires a CONTIGUOUS run, so separators exempt them
    expect(() =>
      assertBoundedMetricLabels("cron.runs", { job: "delivery_stats_rollup", result: "ok" }),
    ).not.toThrow();
    expect(() =>
      assertBoundedMetricLabels("cron.runs", { job: "stripe_transport_reconcile", result: "ok" }),
    ).not.toThrow();
  });
});
