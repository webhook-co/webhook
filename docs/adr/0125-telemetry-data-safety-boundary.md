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
   - **In-CF sinks (Analytics Engine blobs, Workers Logs, Postgres):** opaque tenant/org/endpoint/event ids are
     **allowed** — they are the point of operational triage, they stay within an existing Cloudflare
     sub-processor, and AE keeps them off the single index so they don't drive cardinality.
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

4. **A parse-based CI guard enforces the boundary.** It parses the metric/label catalog (not a text scan) and
   fails on any label key outside the allowlist, any id-shaped label *value*, and any tenant identifier declared
   on an *exported* span. It carries a zero-input floor (an empty catalog fails, so "never ran" cannot read as
   "passed") per the repo's guard-hardening precedent.

## Consequences

- **Redaction is proven by adversarial tests, not asserted.** Each redaction rule has a test that emits a known
  secret/PII value through the boundary and asserts its **absence** downstream; the test fails if the redaction
  is removed (a mocked boundary would be an untested boundary).
- **The URL-secret class is why native export is bounded, not filtered** — the boundary's inability to reach the
  managed span is a load-bearing reason for ADR-0124's worker split, recorded here so the two ADRs stay coherent.
- **The guard is a parser with a floor**, so it cannot silently pass on malformed input or a missing catalog.
- **`data.mdc`'s "never log tenant identifiers" is reconciled, not overridden:** identifiers are permitted in
  **in-CF** sinks for triage and forbidden in **exported** spans and in **metric labels** — the distinction the
  original rule elided. This ADR is the record of that reconciliation.
