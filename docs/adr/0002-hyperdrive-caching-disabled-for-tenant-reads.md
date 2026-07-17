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
- ~~`HYPERDRIVE_CACHED` — caching on — for non-tenant, cache-safe lookups only.~~ **RETIRED 2026-07-17.**
  The binding was read by ZERO source files for its entire life (the only mentions were comments saying never
  to use it), but its existence forced the cache-posture guard to carry a by-name exemption — and two separate
  `/code-review` rounds walked a cross-tenant leak straight through that exemption: an app could bind the
  caching pool beside the tenant one and route org-wide reads (which bind no `org_id`, so their cache key is
  identical across every org) through it with every layer green. The binding is deleted from
  `apps/engine/wrangler.jsonc` and its placeholder from `gen-wrangler-prod.mjs`; the guard now enforces the
  rule ABSOLUTELY — every hyperdrive binding must resolve to a caching-disabled pool, no name skipped. The
  `webhook-prod-cached` config and the `HYPERDRIVE_CACHED_ID` repo var still exist; re-adding the binding means
  re-adding an exemption scoped to an (app, binding) PAIR, never a bare name.

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
