-- migrate:up

-- Soft-delete marker for endpoints (ADR-0076). endpoints.delete sets deleted_at; the row, its
-- captured events, and its R2 payload bodies are RETAINED (inspection history is the product value;
-- a later retention job hard-purges / honors erasure). Three query seams filter on it:
--   * the webhook_authn ingest COLD lookup (endpoints.ts makeEndpointTokenColdLookup) -> a deleted
--     endpoint's token stops resolving, so ingest 404s. This is what makes a KV eviction DURABLE:
--     without it, the next cold miss re-resolves the still-present row and re-caches it. It also makes
--     the system SELF-HEAL within the 300s KV TTL even if explicit eviction is missed.
--   * the per-org create soft-cap count (endpoints.ts createEndpointWithAudit) -> a soft-deleted
--     endpoint no longer counts against the 100/org cap, so delete actually relieves the cap pressure.
--   * the endpoints.list / endpoints.get reads (reads.ts) -> a deleted endpoint is hidden from the
--     read surfaces. (The events read model does NOT join endpoints, so captured events stay readable
--     after a delete — intentional retention.)
--
-- Nullable, no default: a metadata-only add (no table rewrite, no backfill, instant) — every existing
-- row reads NULL = live, which is correct. The UNIQUE(ingest_token_hash) constraint is unchanged: a
-- soft-deleted row keeps its hash, but ingest tokens are 256-bit CSPRNG (never reused), so the retained
-- hash blocks nothing. RLS is unchanged: lifecycle visibility is an application-query concern (the
-- filters above), not org isolation — the delete/rotate paths and a future undelete must still see the row.

alter table endpoints add column deleted_at timestamptz;

-- webhook_authn holds a COLUMN-scoped SELECT grant on endpoints (migration 0011:
-- grant select (id, org_id, ingest_token_hash, paused)). The cold lookup now filters
-- `deleted_at is null`, so the role MUST be able to read deleted_at — otherwise every ingest cold-miss
-- would error with "permission denied for column deleted_at" (a hot-path outage). Additive, least-
-- privilege: a nullable timestamp is low-sensitivity and stays inert against a leaked webhook_authn
-- credential (no write grant; the token hash is a peppered HMAC).
grant select (deleted_at) on endpoints to webhook_authn;

-- migrate:down

-- Rolling back reverts to a world with no soft-delete: dropping deleted_at makes every previously
-- soft-deleted endpoint LIVE again (the three `deleted_at is null` filters all evaluate true), and the
-- engine code that reads the column reverts in lockstep. That is the correct semantics for un-shipping
-- the feature (a rollback, not a data operation) — there is intentionally no preservation of delete state.
revoke select (deleted_at) on endpoints from webhook_authn;
alter table endpoints drop column deleted_at;
