-- migrate:up

-- The free-org-cap reconciler's WRITE capability + grace-window state (PR2b slice 3a).
--
-- Slice 2 gave webhook_capreconciler cross-user READ (detect owners over the cap). This slice lets it ENACT
-- the outcome: flag an overflow org with a grace deadline, then — if still over-cap at the deadline — suspend
-- it (orgs.status) AND pause its ingest (ingest_paused), and later RESTORE it. All cross-org, so the writes
-- ride role-targeted `TO webhook_capreconciler` policies (the same confinement as its reads), never a bare
-- USING(true) another role could evaluate.

-- The grace window. When the cron first sees an org over the cap it sets this to now + GRACE (and warns the
-- owner) but leaves the org ACTIVE; only if it's STILL over-cap at the deadline does it suspend. NULL = not
-- flagged. Cleared when the org is suspended (consumed) or when the user resolves the overage in time.
alter table orgs add column free_org_cap_grace_until timestamptz;

-- Let the reconciler READ the grace column too (its detection/enforcement query reads it). Extends the 0084
-- SELECT grant; the cross-org SELECT policy from 0084 already covers the rows.
grant select (free_org_cap_grace_until) on orgs to webhook_capreconciler;

-- The suspend/restore WRITE on orgs — cross-org, role-targeted. USING/WITH CHECK are `true` because the
-- reconciler acts on any user's overflow org (it has no tenant GUC); the column grant is what bounds it to the
-- suspend-lifecycle fields — it can NEVER rewrite an org's slug, name, region, retention, or image.
create policy orgs_capreconciler_update on orgs
  for update to webhook_capreconciler using (true) with check (true);
grant update (status, suspended_reason, suspended_at, restore_deadline, free_org_cap_grace_until)
  on orgs to webhook_capreconciler;

-- The ingest pause is a SEPARATE dimension (orgs.status gates reads + delivery; ingest_paused gates the edge
-- 429). The reconciler upserts ingest_paused cross-org with reason='free_org_cap', so a suspended org also
-- stops CAPTURING. Role-targeted select/insert/update policies + a column grant covering exactly the upsert
-- shape. No DELETE — a resume flips paused=false, it doesn't remove the row (keeps the reason/since audit).
create policy ingest_paused_capreconciler_select on ingest_paused
  for select to webhook_capreconciler using (true);
create policy ingest_paused_capreconciler_insert on ingest_paused
  for insert to webhook_capreconciler with check (true);
create policy ingest_paused_capreconciler_update on ingest_paused
  for update to webhook_capreconciler using (true) with check (true);
grant select (org_id, paused, reason), insert (org_id, paused, reason, since, updated_at),
      update (paused, reason, since, updated_at)
  on ingest_paused to webhook_capreconciler;

-- migrate:down

revoke update (status, suspended_reason, suspended_at, restore_deadline, free_org_cap_grace_until)
  on orgs from webhook_capreconciler;
revoke select (free_org_cap_grace_until) on orgs from webhook_capreconciler;
drop policy if exists orgs_capreconciler_update on orgs;

revoke select (org_id, paused, reason), insert (org_id, paused, reason, since, updated_at),
       update (paused, reason, since, updated_at)
  on ingest_paused from webhook_capreconciler;
drop policy if exists ingest_paused_capreconciler_select on ingest_paused;
drop policy if exists ingest_paused_capreconciler_insert on ingest_paused;
drop policy if exists ingest_paused_capreconciler_update on ingest_paused;

alter table orgs drop column free_org_cap_grace_until;
