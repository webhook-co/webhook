# ADR-0125: the telemetry data-safety boundary — no secrets or PII in spans, logs, or metric labels

- **Status:** Accepted (S6)
- **Date:** 2026-07-18
- **Relates to:** ADR-0124 (the observability spine), AGENTS.md compliance-by-design ("PII/PHI scrubbing from
  logs", "secrets in a KMS", "region pinning", tenant isolation via RLS), the existing redaction spine
  (`packages/shared/src/redaction.ts`), `.cursor/rules/data.mdc`

## Context

Telemetry is a classic exfiltration vector: span attributes, span events, log fields, and metric labels are all
places a credential or a customer identifier leaks by accident, and telemetry is often shipped to a third-party
processor in a different region. The constitution forbids secrets outside a KMS, mandates PII/PHI scrubbing from
logs, and pins data to a region. S6 must design the data-safety boundary *before* any span or metric exists, and
test it adversarially (a test that fails when redaction is removed).

Two runtime facts (verified 2026-07-18) shape the boundary:

- **Secrets already live in the URL on several surfaces.** Ingest: the bearer token is the first path segment.
  Auth: `?code`/`?state`. Web: invite `?token`, auth `?ticket`. Cloudflare's automatic span records
  `url.full`/`url.path`/`url.query` with no application redaction hook.
- **The repo already has an allowlist redaction spine** — `redactSecret`, `LOGGABLE_HEADER_ALLOWLIST`,
  `redactHeadersForLog` — allowlist-based and fail-closed, already used at the ingest log site. S6 reuses it
  rather than inventing a second, weaker one.

## Decision

**Allowlist, never denylist. Every attribute we emit — on a span, a log, or a metric — passes an explicit
allowlist boundary; anything not on the list is dropped or redacted. Identifiers are tiered by sink.**

1. **`spanSafeAttributes()` / the log/metric attribute boundary** wraps `redactSecret` +
   `LOGGABLE_HEADER_ALLOWLIST`. It emits `http.route` as a **templated** value (`/:token`,
   `/callback`) and **never** `url.path`, `url.full`, or `url.query`; headers are allowlisted; request/response
   bodies are never attributes; known secret shapes (`whk_…`, bearer tokens, signing secrets, DEKs) are
   redacted to a short prefix. This boundary governs *our* spans/logs/metrics only — it **cannot** reach
   Cloudflare's managed root span, which is why native trace **export** is removed from every worker whose edge
   carries a URL secret (ADR-0124 §3), not merely filtered.

2. **Identifier tiers by sink:**
   - **Metric labels:** no tenant/org/endpoint/event id, and no URL, ever — labels are enums, templated routes,
     `plan`, or job names. This bounds cardinality (and cost) independent of tenant count.
   - **In-CF sinks (Analytics Engine blobs, Workers Logs, Postgres, and the CF-dashboard trace store while
     tracing is dashboard-only — ADR-0124 §3):** opaque tenant/org/endpoint/event ids are **allowed** — they are
     the point of operational triage, they stay within an existing Cloudflare sub-processor, and AE keeps them off
     the single index so they don't drive cardinality. Native tracing shipped dashboard-only (no `destinations`),
     so its spans land in this in-CF tier; the founder's "allow identifiers, region-pinned" ruling (2026-07-19)
     is satisfied here without any data leaving Cloudflare.
   - **Exported spans (to an off-platform, possibly cross-region backend):** **no tenant/org identifier**. An
     `org_id` mapping to an identifiable EU customer is pseudonymous personal data (GDPR Recital 26); exporting
     it to a new sub-processor is a residency/DPA decision, not a default. Per-tenant *external* trace
     drill-down, if ever wanted, is a deliberate purchase (region-pinned destination + DPA + sub-processor
     listing), ratified separately.

3. **Inbound W3C trace context is treated as CF's decision, not a control we own.** Cloudflare owns the root
   span and does not expose an API to read, set, or restart its trace-id, and it does not honour an inbound
   external `traceparent` today. We therefore do **not** claim to "restart trace context at the ingest edge" —
   that control is unimplementable on native and stating it would be a false assurance. If CF later ships inbound
   W3C propagation, the forced-100%-sampling cost-amplification risk must be re-evaluated (and is one reason a
   local library-side sampler is the only real DoS defence — deferred, ADR-0124 §4).

4. **The bounded catalog is enforced by the type system plus a floor-checked validator run in CI.** The metric
   catalog is a typed TS literal (not a JSON import — that broke Node's native-ESM consumers), so
   `labels ⊆ allowlist` is a COMPILE-TIME error to violate. A `catalogViolations()` validator — exercised by the
   test suite — covers the checks the types can't: no id-shaped label key, and a zero-input floor (an
   empty/absent catalog is a violation, so "never checked" cannot read as "passed"). `assertBoundedMetricLabels`
   is the runtime emit-site defense against an id/PII-shaped label *value*.

## Consequences

- **Redaction is proven by adversarial tests, not asserted.** Each redaction rule has a test that emits a known
  secret/PII value through the boundary and asserts its **absence** downstream; the test fails if the redaction
  is removed (a mocked boundary would be an untested boundary).
- **The URL-secret class is why native export is bounded, not filtered** — the boundary's inability to reach the
  managed span is a load-bearing reason for ADR-0124's worker split, recorded here so the two ADRs stay coherent.
- **Enforcement is the type system plus a floor-checked validator**, not a text scan — a bad label is a compile
  error or a failing test, never a silent pass, and a missing/empty catalog fails closed.
- **`data.mdc`'s "never log tenant identifiers" is reconciled, not overridden:** identifiers are permitted in
  **in-CF** sinks for triage and forbidden in **exported** spans and in **metric labels** — the distinction the
  original rule elided. This ADR is the record of that reconciliation.
