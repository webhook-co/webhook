-- migrate:up

-- Per-endpoint deduplication config (ADR-0104). A JSON object
--   { mode: 'identifier'|'content'|'fields'|'off', windowSeconds: int, fields?: {...} }
-- validated at write time by the contract (packages/shared DedupConfigSchema); NULL = the default
-- (identifier ladder, 24h) so every existing row keeps today's behavior. The engine reads it off the
-- resolved principal (one KV read) and feeds it to deriveDedup; the value is opaque to Postgres.
--
-- Nullable, no default: a metadata-only add (no table rewrite, no backfill, instant). jsonb (not json)
-- so a future query could index/inspect it; RLS is unchanged (the config is not org-isolation state —
-- the existing endpoints_* org policies already cover the new column for the control plane).

alter table endpoints add column dedup_config jsonb;

-- webhook_authn holds a COLUMN-scoped SELECT grant on endpoints (migration 0011 +
-- 0021: grant select (id, org_id, ingest_token_hash, paused, deleted_at)). The ingest COLD lookup
-- (endpoints.ts makeEndpointTokenColdLookup) now also selects dedup_config so the engine can resolve
-- the endpoint's dedup mode from the single KV read, so the role MUST be able to read it — otherwise
-- every cold-miss would error "permission denied for column dedup_config" (a hot-path outage).
-- Additive, least-privilege: the config carries no secrets and stays inert against a leaked
-- webhook_authn credential (no write grant; token hash is a peppered HMAC).
grant select (dedup_config) on endpoints to webhook_authn;

-- migrate:down

-- Rolling back un-ships configurable dedup: every endpoint reverts to the default (identifier/24h),
-- which is exactly the engine behavior when dedup_config is absent — a clean rollback, not a data op.
revoke select (dedup_config) on endpoints from webhook_authn;
alter table endpoints drop column dedup_config;
