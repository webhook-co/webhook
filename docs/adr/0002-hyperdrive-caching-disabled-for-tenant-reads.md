# ADR 0002 — Hyperdrive query caching is disabled for tenant reads

- status: accepted
- date: 2026-06-12
- scope: `apps/engine`, `packages/db`
- review severity: critical

## context

Tenant isolation rests on Postgres RLS: every tenant read runs with `app.current_org`
set, and policies gate rows on `org_id = current_org_id()`. Hyperdrive, Cloudflare's
edge connection pooler, also offers a query cache. That cache is keyed on the SQL text
plus bound parameters — it is **blind to the session GUC** that RLS depends on. The
exact same parameterized query (`select … from events where …`) issued under org A's
context and later under org B's context hashes to the same cache key. A cached result
from org A could therefore be served to org B. RLS is correct; the cache in front of it
is not tenant-aware. (Confirmed against Cloudflare's Hyperdrive caching docs: caching
is on by default and keyed on SQL+params.)

## decision

Tenant-scoped reads go **only** through a dedicated **cache-disabled** Hyperdrive
binding. The engine declares two bindings:

- `HYPERDRIVE_TENANT` — `caching` disabled — for **all** tenant-scoped reads/writes.
- `HYPERDRIVE_CACHED` — caching on — for non-tenant, cache-safe lookups only.

All tenant data access is routed through the `packages/db` client so no surface can
accidentally pick the cached binding for tenant rows. KV stays the cache for hot,
non-tenant endpoint-resolution data (keyed by the ingest-token hash).

## consequences

- Tenant reads lose Hyperdrive's result-cache speedup; they still get pooling and the
  in-region Neon round-trip. This is the correct trade — correctness over a cache that
  can't see tenancy.
- A CI lint (follow-up) asserts no tenant-table read is issued on the cached binding.
- Documented in `docs/threat-model.md` (the Hyperdrive cache trust boundary) and the
  `packages/db` README; the binding is wired in the engine's `wrangler.jsonc`.
