-- migrate:up

-- events.delete as a TOMBSTONE (S3). A hard delete of an event is a self-serve billing exploit and a
-- metering-integrity hazard: delivery_attempts cascades from events (0003:149) and BOTH legs are metered
-- (Definition B, 0049), so a hard delete of recent events would recompute the bill DOWN on the next rollup,
-- evade the live soft cap, poison the F6 reconciliation oracle, AND free the unique(endpoint_id, dedup_key)
-- slot so the same webhook could be re-ingested and re-billed. So a user delete is a TOMBSTONE: the row
-- stays (count(*) is stable, the dedup slot stays occupied), the PII-bearing captured content is redacted
-- in the same transaction, and the R2 body is purged asynchronously. Mirrors the endpoints soft-delete
-- precedent (ADR-0076, migration 0021).
--
-- Nullable, no default, no rewrite — a plain metadata-only ALTER. Every event reader that SURFACES event
-- data must filter `deleted_at is null` (reads.ts getEvent/listEvents/tail*, the delivery DO's due-read);
-- the metering count(*) seams (rollup_usage, period-usage, meter-reconcile, usage-rollup) must NOT — a
-- tombstone is still a captured event that was billed, and un-counting it would drift every guard. The
-- readers that filter (webhook_app) hold a table-level SELECT (0003:187), which covers this new column, so
-- no column-scoped grant is added here; the metering roles never read it.
alter table events add column deleted_at timestamptz;

-- ── event_payload_purge: the async R2 body purge queue ───────────────────────────────────────────────────
-- One row per tombstoned event whose R2 body must be deleted. Deliberately NOT foreign-keyed to events: it
-- outlives the event row (the retention prune may hard-delete the tombstone before the purge drains, and the
-- purge must still complete). Self-contained: it carries the org + endpoint + stored key the engine needs to
-- fence the delete to `org/{org_id}/ep/{endpoint_id}/` (the H1 principal fence) before removing the object.
-- Modeled on org_deletions (0051); drained by the SAME cross-org engine cron role, webhook_purge.
create table event_payload_purge (
  event_id uuid primary key,
  org_id uuid not null,
  endpoint_id uuid not null,
  payload_r2_key text not null,
  status text not null default 'purging' check (status in ('purging', 'completed')),
  requested_at timestamptz not null default now(),
  purge_completed_at timestamptz
);

alter table event_payload_purge enable row level security;
alter table event_payload_purge force row level security;

-- webhook_app enqueues the purge in the SAME transaction as the tombstone (org_id is its RLS-pinned org) and
-- may read back only its own org's jobs; it never mutates or deletes them. The insert `with check` is the
-- security boundary: a tenant cannot enqueue a purge for a key outside its own org (which would otherwise let
-- it destroy another org's R2 payloads). The stored key is additionally fenced to the org+endpoint prefix by
-- the engine drain before the R2 delete — defense in depth.
grant insert, select on event_payload_purge to webhook_app;
create policy event_payload_purge_app_insert on event_payload_purge
  for insert to webhook_app with check (org_id = current_org_id());
create policy event_payload_purge_app_select on event_payload_purge
  for select to webhook_app using (org_id = current_org_id());

-- webhook_purge: the cross-org engine cron that drains the R2 purge (the sole R2-delete principal). SELECT to
-- find + fence outstanding jobs, column-scoped UPDATE to flip completion. No INSERT, no DELETE, no access to
-- any tenant table (least privilege). The role already exists (0051); this only extends it to the new queue.
grant select (event_id, org_id, endpoint_id, payload_r2_key, status, requested_at)
  on event_payload_purge to webhook_purge;
grant update (status, purge_completed_at) on event_payload_purge to webhook_purge;
create policy event_payload_purge_purge_select on event_payload_purge
  for select to webhook_purge using (true);
create policy event_payload_purge_purge_update on event_payload_purge
  for update to webhook_purge using (status = 'purging') with check (status in ('purging', 'completed'));

-- The drain scans outstanding jobs oldest-first; partial index keeps it index-driven.
create index event_payload_purge_purging_idx on event_payload_purge (requested_at) where status = 'purging';

-- migrate:down

drop index if exists event_payload_purge_purging_idx;
drop policy if exists event_payload_purge_purge_update on event_payload_purge;
drop policy if exists event_payload_purge_purge_select on event_payload_purge;
drop policy if exists event_payload_purge_app_select on event_payload_purge;
drop policy if exists event_payload_purge_app_insert on event_payload_purge;
revoke all on event_payload_purge from webhook_purge;
revoke all on event_payload_purge from webhook_app;
drop table if exists event_payload_purge;

alter table events drop column if exists deleted_at;
