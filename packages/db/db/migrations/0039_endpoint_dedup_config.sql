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
--
-- DEPLOY ORDERING: the ingest cold lookup (endpoints.ts) now SELECTs dedup_config, so this migration
-- MUST be applied to prod BEFORE the engine that reads it deploys — otherwise a cold-miss ingest errors
-- ("column dedup_config does not exist" / "permission denied") and 500s. The deploy pipeline enforces
-- migration-before-code (deploy.yml blocks auto-deploy on an unapplied migration change), so this is the
-- standard flow, not a new manual step.

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

-- Rolling back un-ships configurable dedup. NOTE: once the write path (Slice 3) has shipped and
-- operators have set per-endpoint config, dropping the column is DESTRUCTIVE — every operator-set config
-- is lost and those endpoints silently revert to identifier/24h (an `off` endpoint would start collapsing
-- distinct events; a widened-window endpoint loses its window). Before rolling back on a system with live
-- config, export `select id, dedup_config from endpoints where dedup_config is not null` first. On a
-- pre-Slice-3 system the column is uniformly NULL, so the rollback is a true no-op.
revoke select (dedup_config) on endpoints from webhook_authn;
alter table endpoints drop column dedup_config;
