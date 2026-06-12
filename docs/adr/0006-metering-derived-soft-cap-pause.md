# ADR 0006 — metering is events-derived with a soft-cap pause

- status: accepted
- date: 2026-06-12
- scope: `packages/db`, `packages/shared`, `apps/engine` (ingest path)
- review id: H3 (high)

## context

Metering must be accurate, single-dimension (events), and replay-safe — but it must not
add write contention to the unauthenticated ingest hot path. A naive per-event counter
inside `ingest_event` would reintroduce per-org serialization on the exact path §0.2
works to keep as a single, lock-light statement. Pricing transparency also calls for a
soft cap that **pauses rather than bill-shocks**.

## decision

- **Derived metering, no hot-path counter.** Usage is **derived from `events`** by an
  async rollup (`rollup_usage(window)`, migration `0007`), not counted in
  `ingest_event`. Exactly-once falls out of the unique `(endpoint_id, dedup_key)`
  constraint: a retry never creates a second row, so it can't be double-counted. The
  rollup is RLS-safe (per-org, `SECURITY INVOKER`) and idempotent (recompute + upsert).
- **Soft-cap pause via a cached signal.** The cap→pause decision (`shouldPauseForCap`,
  `packages/shared`) is computed off the hot path by the metering job and written to
  `ingest_paused`. The ingest path reads a **cheap cached `paused` flag** on KV
  endpoint-resolution — **never a synchronous DB count**. Over-cap pauses ingest and
  returns the agreed status; `pause_policy` is `pause` (default) or `allow`.
- **Rate-limit seam.** Abuse control is a seam (`RateLimiter`, `packages/shared`):
  Cloudflare Rate Limiting at the edge + a per-token Durable Object token-bucket, both
  implemented in phase 1.
- **No prices/tiers/cost figures in this repo.** Schema is `usage`, `org_limits`
  (numeric cap + policy enum), `ingest_paused` (migration `0004`). Billing/Stripe is a
  separate later system.

## consequences

- The ingest hot path stays a single statement; metering integrity comes from the dedup
  constraint, not a counter.
- Soft-cap enforcement is O(1) cache read on ingest; the expensive part (usage vs cap)
  runs off the hot path.
- Recorded in `docs/threat-model.md` (usage/metering data class) and the migrations
  noted above.
