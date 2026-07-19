# ADR-0124: OpenTelemetry observability — the inverted spine

- **Status:** Accepted (S6; slices 0–4 shipped — native tracing enabled dashboard-only on `api`/`www`/`get`)
- **Date:** 2026-07-18 (updated 2026-07-19: slice 4 shipped — see Rollout)
- **Relates to:** AGENTS.md ("Observability | OpenTelemetry"), ADR-0123 (async org deletion — the
  `delivery_attempts` correlation key already exists there), the ingest hot path (`apps/engine/src/ingest.ts`),
  the CLI-telemetry collector (`apps/telemetry`, Analytics Engine — a *naming* neighbour, not this system)

## Context

AGENTS.md commits the stack to OpenTelemetry for observability, but nothing implements it: the only
`@opentelemetry/*` packages in the lockfile are `api` + `semantic-conventions`, both transitive (better-auth /
next). There is no SDK, no exporter, no context propagation, and `observability.enabled:true` on every worker is
Cloudflare **Workers Logs**, not tracing. This is greenfield.

The intuitive design — "adopt OpenTelemetry tracing, native-first, everywhere" — was researched, then
adversarially refuted, and it **does not survive on the workers that matter**, for reasons confirmed against
Cloudflare's primary docs on 2026-07-18:

1. **Cloudflare's automatic fetch-handler span records `url.full`, `url.path`, and `url.query`, and the runtime
   exposes no mechanism to redact or suppress attributes on the automatic (non-custom) span**
   (`developers.cloudflare.com/workers/observability/traces/spans-and-attributes/`). The ingest bearer token
   *is* the first path segment (`wbhk.my/<token>`, `apps/engine/src/ingest.ts` `ingestPathToken`), so enabling
   native trace **export** on the engine would stream a live, reusable credential to the export destination.
   The same class bites `auth` (`?code`/`?state`), `web` (`?token`/`?ticket`), and likely `mcp` (OAuth
   callback). Our allowlist redaction (`packages/shared/src/redaction.ts`) can only touch attributes on *our*
   spans, never the managed root span.

2. **OpenTelemetry metrics cannot be exported from Workers** — "Metrics export … via OpenTelemetry is not
   currently available" (`developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/`), and
   there is no background timer between requests for a periodic-export `MeterProvider`. Metrics therefore cannot
   live on the trace plane at all.

3. **Head sampling guts custom spans on the hot path.** The engine needs a low `head_sampling_rate` (~0.5%);
   custom `tracing.enterSpan()` spans then record nothing for ~199/200 requests, and head sampling (decided at
   request start) cannot preferentially keep slow/error traces — so native tracing cannot be the DB-latency
   spine even ignoring (1).

What native tracing *does* deliver: standard OTLP/JSON export to any third-party backend (portable), and
**automatic trace-context stitching across service-binding RPC and Durable Object subrequests**
(`developers.cloudflare.com/changelog/post/2026-05-07-automatic-tracing-across-do-and-worker-subrequests/`) —
which closes the largest silent-drop class (13 `WorkerEntrypoint` providers, injected at deploy by
`gen-wrangler-prod.mjs`). But `spanContext()` is unavailable
(`developers.cloudflare.com/workers/observability/traces/custom-spans/`, "planned for a future release"), so an
application cannot read a trace id to persist or propagate; cron/alarm invocations are separate roots (not
stitched to whatever scheduled them); and external W3C propagation is unshipped.

## Decision

**The observability spine inverts. On the data plane (engine) and on every worker whose public edge carries a
secret in path or query, the primary spine is Analytics Engine (RED metrics) + 100% structured logs + durable
Postgres rows. Native OpenTelemetry tracing is a secondary, bounded topology tool, exported only from workers
proven free of URL-embedded secrets.**

1. **Metrics → Cloudflare Analytics Engine** (forced by (2) above; reuses the muscle already in
   `apps/telemetry`). A RED catalog (rate / errors / duration) plus delivery attempts+retries and a
   DO-saturation gauge, written via `writeDataPoint` **in-handler** (AE writes are durable; no `waitUntil`
   needed). Every label is an enum, a templated route, a `plan`, or a job name — **never** a tenant/org/
   endpoint/event id or a URL — so the series count is bounded (~1.8k/env) independent of tenant count. AE is an
   unbiased *estimate* under storage sampling (`sum(_sample_interval)`, not `count()`), 90-day retention, and
   its own SQL API with DIY alerting — it is a compromise metrics store, accepted deliberately (see
   Consequences). "Did we drop event X" is answered from durable Postgres rows / 100% logs, **never** from AE or
   a sampled trace.

2. **The received→delivered correlation ships day-one on the log/DB plane, not the trace plane.** This is the
   flagship signal ("was customer X's hook delivered — why slow/failed") and is *not* deferred. `delivery_attempts`
   already carries `event_id` and `insertQueuedDelivery` already mints a `crypto.randomUUID()` at enqueue
   (`packages/db/src/delivery.ts`), so a single nullable, forward-only `correlation_id` column plus 100%
   `event_id`/`correlation_id`-keyed structured logs on both the ingest side and the delivery-DO alarm side give
   full, unsampled, in-CF correlation across a time-shifted seam (retries span 5s→~27h, 8 attempts —
   `packages/shared/src/delivery-retry.ts`). A first-class W3C span **link** is a strictly better mechanism but
   is genuinely blocked by CF (`spanContext()` absent); it is deferred *and labelled as such*, not faked.

3. **Native tracing is enabled only on workers with no URL-embedded secret, and dashboard-only (no export
   destination).** The firsthand per-worker URL-secret audit (2026-07-19) cleared `api` / `www` / `get`
   (bearer strictly in headers/body; path+query carry only opaque resource ids, filters, static routes) and
   `telemetry` (body-only). It is **not** enabled on `engine` / `auth` / `web` / `mcp` / `play` — each carries a
   secret in path or query, and CF's auto fetch span records `url.path`/`url.query` with no redaction hook.
   Enablement is **dashboard-only**: `observability.traces.enabled` with **no `destinations`**, so spans are
   collected/stored/viewed inside Cloudflare and never leave it (same residency as our Analytics Engine metrics),
   and it is **free during the CF tracing beta** — the per-span billing that lands 2026-03-01 is on the external
   *export* path we deliberately do not take. Each enabled worker declares a deliberate `head_sampling_rate`
   (`api` 0.2, `www`/`get` 0.05); head-based sampling means non-sampled requests incur **zero** tracing overhead
   (CF docs), and none of the three is on the ingest ACK hot path. This audit boundary is now a **checked
   property**: `scripts/tracing-safety-guard.mjs` (wired into `pnpm lint`) fails the build if tracing is enabled
   on any worker outside the audited-safe allowlist, if it is silently removed from an enabled worker, or if a
   brand-new worker is added without a deliberate classification. Custom `enterSpan` spans, where later used,
   route through the `spanSafeAttributes()` boundary (ADR-0125); v1 relies on CF's automatic instrumentation
   (fetch / RPC / DO / DB subrequests) only — no custom spans, no `spanContext()` dependency.

4. **The library path (`@microlabs/otel-cf-workers` / a vanilla SDK) is rejected for v1.** It is the only way to
   read a trace id (for a first-class ingest→delivery link) or to run a local sampler (forced-sampling-DoS
   defence), but it is dormant (~14 months, RC, 43 open issues), it puts per-event CPU + a flush-before-freeze
   footgun on the hot path, and it *still* cannot export metrics. It is reconsidered only if trace-plane
   end-to-end links or DoS defence become v1 requirements (they are not) or CF ships `spanContext()` + inbound
   W3C.

## Consequences

- **The hot path carries zero beta-tracing API inline.** Ingest observability is `writeDataPoint` (in-CF) +
  per-step timings on the existing `ingest.captured` log + durable rows — so there is no structural way for S6 to
  regress the ACK-path p99. The claim is still *measured*, not assumed (ADR references the extended bench).
- **No distributed traces on the engine or auth in v1.** The constitution's observability intent is met by
  metrics + 100% logs + Postgres; trace spans on those edges are blocked by CF's missing redaction hook, not by
  unwillingness. This is a founder-ratified acceptance, recorded here.
- **The marquee "free RPC-mesh stitching across 13 entrypoints" is real but only exportable from the token-free
  workers** — its practical reach is a fraction of the first framing, because the mesh's most valuable public
  entry points (ingest, OAuth) are export-blocked.
- **AE is a compromise, and the design leans on that honestly:** RED is estimate-only; SLO history is capped at
  90 days; alerting is DIY on the SQL API. Anything requiring exactness (drop detection, per-event audit) is a
  durable Postgres row, not a metric.
- **`apps/telemetry` is unrelated.** It is the cookieless CLI-usage collector on `telemetry.wbhk.my`; S6 metrics
  reuse the same Analytics Engine *technique* but a distinct dataset/binding. The name collision is noted so
  neither is mistaken for the other.

## Rollout (slices 0–4 shipped)

Slices 0–3.5 (redaction boundary + CI guard → bench-through-`handleIngest` baseline → I/O step timings → AE
metrics + Postgres drop-detection → `correlation_id`/`event_id` 100% logs) require no external vendor and no new
prod secret; Analytics Engine is a binding, not a secret. The shipped correlation is **log-only on `events.id`**
(the abandoned external-id column in migration 0090 means no new migration was needed) — a strictly-inert change.

**Slice 4 (native tracing) shipped 2026-07-19, dashboard-only on `api`/`www`/`get`.** How the original gates
resolved:

- **(a) per-worker URL-secret audit — done, firsthand.** `api`/`www`/`get` cleared (bearer in header/body; no
  secret in path/query); `telemetry` also cleared (body-only) but is not enabled in v1; `engine`/`auth`/`web`/
  `mcp`/`play` confirmed unsafe. The audit is frozen into `scripts/tracing-safety-guard.mjs`, so it is enforced
  on every future PR, not a one-time reading.
- **(b) residency ruling on identifiers in exported spans — moot for v1, gate kept armed.** The founder chose
  **dashboard-only** (no `destinations`), so spans never leave Cloudflare — the same residency as the AE metrics.
  Identifiers are therefore permitted on this in-CF span sink (the founder's "allow, region-pinned" ruling); the
  `spanSafeAttributes()` "forbid identifiers on export" gate stays in place for the day an external OTLP
  destination is ever attached, at which point (b) must be re-answered before that destination is added.
- **(c) p99 / CPU-ms spike — structurally bounded, deploy-time confirmation still recommended.** These three
  workers are **off** the ingest ACK hot path (the engine, which is excluded); head-based sampling incurs **zero
  overhead on non-sampled requests** (CF docs), and the rates are low. A disposable-deploy ON-vs-OFF spike is a
  deploy-gated step a background agent cannot run; it is recommended as a confirmation but is not load-bearing
  for dashboard-only tracing on non-hot-path workers.
- **(d) wrangler beta-schema wedge — not a risk for this generator.** `gen-wrangler-prod.mjs` is string
  token-replacement, not schema validation, so a `traces` schema change cannot wedge the shared generator; a
  breaking change would surface as a deploy error on the one worker, not a cross-app block.

**No OTLP secret is committed** and none exists — dashboard-only needs no destination. If an external destination
is ever adopted, its endpoint is configured at the Cloudflare account level (not the repo) and any auth header
MUST be a Secrets Store secret, never a `var`; adopting a library path re-opens decision (4) above.
