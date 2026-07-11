-- migrate:up

-- The cross-org retention-prune role (data-lifecycle slice 2.3). A per-plan TTL: an engine cron deletes
-- each org's captured events (and cascades their delivery_attempts) once they age past that org's retention
-- window, so the payload BODIES in R2 can be purged too. Free = 7 days; paid tiers keep longer (the policy
-- lives in packages/shared/src/retention.ts). While billing is dark every org is Free, so this role prunes
-- to the 7-day window — but it EXCLUDES any org with an entitled subscription (see the cron's NOT EXISTS on
-- billing_subscriptions), so a paying customer is never pruned at the Free window before per-plan
-- enforcement is wired at billing activation (over-retention is the safe miss, under-retention deletes paid
-- data). That is why this role — unlike a bare DELETE-only sweeper — also reads billing_subscriptions.status.
--
-- METERING SAFETY (the load-bearing invariant): pruning a day's events NEVER changes a billed count. The
-- enforced/period count reads PRIOR days from the frozen, trigger-immutable `usage` table (0040) and only
-- TODAY live from `events`; retention is >= 7 days, so the prune never touches today's live-counted bucket
-- and every pruned day is already summed into an immutable `usage` row. The one hazard is the reconcile
-- money-guard recounting a pruned day and false-alarming — handled OUTSIDE this migration by clamping the
-- reconcile lookback strictly inside the Free window once this role/Hyperdrive is provisioned
-- (RETENTION_ACTIVE_RECONCILE_LOOKBACK_DAYS = 6). See meter-reconcile.ts.
--
-- LEAST PRIVILEGE, and why it needs SELECT (unlike webhook_sweeper's DELETE-only): the R2 payload key is
-- CONTENT-ADDRESSED (payloadR2Key folds in the body's sha256), so it cannot be re-derived from the event
-- row — the cron must SELECT the STORED events.payload_r2_key to know which R2 objects to delete. So:
--   * SELECT (id, org_id, received_at, payload_r2_key) on events — the enumeration/delete keys + the R2
--     object key. `id` is needed to page + to qualify the DELETE (`where id in …` reads the column, and the
--     `returning id` reads it back). Deliberately NOT headers/verification/dedup/content (mirrors
--     webhook_meter's column-scoped read).
--   * DELETE on events — the prune itself; delivery_attempts follow via the ON DELETE CASCADE (0003:202),
--     which runs with the parent delete's rights, so no direct grant on delivery_attempts is needed.
--   * SELECT (org_id, status) on billing_subscriptions — ONLY to EXCLUDE entitled orgs from pruning. Not
--     the plan/price id, not the period bounds, not the stripe ids.
-- A leaked webhook_retention credential can, at worst, read those columns cross-org and delete events older
-- than 7 days — it cannot read payload/header content, cannot touch identity/billing writes, and the DELETE
-- policy's age floor (below) blocks it from ever deleting an in-retention event.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'webhook_retention') then
    create role webhook_retention login nosuperuser nobypassrls nocreatedb nocreaterole;
  end if;
end
$$;

grant usage on schema public to webhook_retention;

-- Column-scoped SELECT on events: enumerate expiring rows (id + received_at) + read the content-addressed
-- R2 key to purge + endpoint_id to FENCE that key to `org/{org}/ep/{endpoint}/` before deleting the object
-- (readPayloadKey, matching every other engine path that acts on a stored key — H1). `id` also qualifies the
-- DELETE's `where id in …` and its `returning id`.
grant select (id, org_id, endpoint_id, received_at, payload_r2_key) on events to webhook_retention;
-- DELETE on events (cascades delivery_attempts). The row-count is the prune's only write.
grant delete on events to webhook_retention;
-- Column-scoped SELECT on billing_subscriptions: read only (org_id, status) to skip entitled/paid orgs.
grant select (org_id, status) on billing_subscriptions to webhook_retention;

-- Role-targeted permissive policies (events + billing_subscriptions are FORCE RLS). SELECT USING (true)
-- gives this role the cross-org read the cron needs WITHOUT bypassing RLS (BYPASSRLS is forbidden here, and
-- a SECURITY DEFINER would be defeated by FORCE RLS). These are scoped TO webhook_retention, so they never
-- widen what webhook_app (org-scoped) can see.
create policy events_retention_select on events
  for select to webhook_retention using (true);
-- The DELETE policy's USING is the DB-LAYER security boundary, not just an app-layer filter (data.mdc: never
-- rely on app filtering alone for data protection). It bounds a bare/WHERE-less DELETE two ways:
--   1. an age FLOOR pinned to the tightest (Free) window — `7 days` == FREE_RETENTION_DAYS in
--      packages/shared/src/retention.ts (raw SQL can't import it; keep them in step) — so even a query with
--      no WHERE can only remove events older than 7 days, never an in-retention one; and
--   2. the SAME entitled-org anti-join the DAL uses, so a leaked webhook_retention credential running a bare
--      cross-org `delete from events where received_at < now() - interval '7 days'` still CANNOT delete a
--      paying org's events (the one thing the design calls catastrophic). The subquery reads
--      billing_subscriptions under this role's own SELECT policy + (org_id, status) grant.
-- The cron's own WHERE narrows further to each org's window (paid windows are all > 7d, so the floor permits
-- them); a per-org cutoff can't live in a static policy, hence the conservative floor + query-side narrowing.
create policy events_retention_delete on events
  for delete to webhook_retention using (
    received_at < now() - interval '7 days'
    and not exists (
      select 1 from billing_subscriptions b
      where b.org_id = events.org_id
        and b.status in ('active', 'trialing', 'past_due')
    )
  );
create policy billing_subscriptions_retention_select on billing_subscriptions
  for select to webhook_retention using (true);

-- No new index: the cron's received_at range scan rides events_received_at_brin (0040) and the per-org
-- listing rides events_org_recent_idx (0003); the DELETE is by primary key (id list).

-- migrate:down

drop policy if exists billing_subscriptions_retention_select on billing_subscriptions;
drop policy if exists events_retention_delete on events;
drop policy if exists events_retention_select on events;
revoke select (org_id, status) on billing_subscriptions from webhook_retention;
revoke delete on events from webhook_retention;
revoke select (id, org_id, endpoint_id, received_at, payload_r2_key) on events from webhook_retention;
revoke usage on schema public from webhook_retention;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'webhook_retention') then
    drop role webhook_retention;
  end if;
end
$$;
