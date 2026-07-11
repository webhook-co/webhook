-- migrate:up

-- Per-plan retention windows (data-lifecycle slice 2.3b).
--
-- 0053 shipped the prune with a HARDCODED 7-day window and an anti-join that EXCLUDED every org with an
-- entitled subscription. That was correct while billing was dark (no paid orgs exist, so every org is Free),
-- but the pricing page already advertises 30-day (Pro) and 90-day (Scale) retention, and nothing enforced
-- them: a paid org's data would have been kept forever. This makes the window per-org, so the promise is
-- actually kept — and it must land BEFORE BILLING_MODE is ever flipped.
--
-- The window lives on `orgs`, not `org_limits`, because org_limits is SPARSE — it only gets a row when a
-- subscription is mirrored, so a Free org has none. Every org has an `orgs` row by construction, so a column
-- here is total and needs no coalesce-over-a-missing-row.
--
-- NULL = UNLIMITED (never pruned). This falls out of SQL rather than being special-cased: the predicate is
--   received_at < now() - (retention_days * interval '1 day')
-- and NULL * interval → NULL, so the comparison is NULL → not true → the row is never deleted. Enterprise
-- (contractual retention) is exactly this. DEFAULT 7 = the Free window, so a brand-new org is pruned
-- correctly with no application involvement.
alter table orgs add column if not exists retention_days integer default 7;

-- Backfill: every org that exists today is Free (billing has never been live), so 7 days is correct for all
-- of them. Doing this explicitly rather than relying on the DEFAULT, which only applies to NEW rows.
update orgs set retention_days = 7 where retention_days is null;

-- A window is either unlimited (NULL) or a positive number of days. 0/negative would mean "delete everything
-- immediately", which no plan should ever be able to express by accident.
alter table orgs drop constraint if exists orgs_retention_days_positive;
alter table orgs add constraint orgs_retention_days_positive
  check (retention_days is null or retention_days > 0);

-- ── webhook_billing: mirrors the plan's window in, alongside the event cap ───────────────────────────────
-- Confined to the caller's own org by RLS, exactly like its org_limits writes (0048). Column-scoped: this
-- role may update retention_days and NOTHING else on orgs.
create policy orgs_billing_update on orgs
  for update to webhook_billing using (id = current_org_id()) with check (id = current_org_id());
grant select (id, retention_days) on orgs to webhook_billing;
grant update (retention_days) on orgs to webhook_billing;

-- ── webhook_retention: reads each org's window ───────────────────────────────────────────────────────────
create policy orgs_retention_select on orgs for select to webhook_retention using (true);
grant select (id, retention_days) on orgs to webhook_retention;

-- ── The DELETE policy — the actual security boundary ─────────────────────────────────────────────────────
-- Replaces 0053's hardcoded 7-day floor + paid-org exclusion with the org's OWN window. This is the bound a
-- leaked webhook_retention credential runs into: a bare `delete from events` still cannot remove anything
-- inside any org's retention window, and can never touch an unlimited (NULL) org at all. The application's
-- predicates (packages/db/src/retention.ts) mirror this, but the policy — not the app — is what enforces it
-- (data.mdc: never rely on app-layer filtering alone).
drop policy if exists events_retention_delete on events;
create policy events_retention_delete on events
  for delete to webhook_retention using (
    received_at < now() - (
      (select o.retention_days from orgs o where o.id = events.org_id) * interval '1 day'
    )
  );

-- The billing_subscriptions read existed only to power the old paid-org exclusion. The window now comes from
-- `orgs`, so drop it: this role should not see subscription state at all.
drop policy if exists billing_subscriptions_retention_select on billing_subscriptions;
revoke select (org_id, status) on billing_subscriptions from webhook_retention;

-- migrate:down

grant select (org_id, status) on billing_subscriptions to webhook_retention;
create policy billing_subscriptions_retention_select on billing_subscriptions
  for select to webhook_retention using (true);

drop policy if exists events_retention_delete on events;
create policy events_retention_delete on events
  for delete to webhook_retention using (
    received_at < now() - interval '7 days'
    and not exists (
      select 1 from billing_subscriptions b
      where b.org_id = events.org_id
        and b.status in ('active', 'trialing', 'past_due')
    )
  );

revoke select (id, retention_days) on orgs from webhook_retention;
drop policy if exists orgs_retention_select on orgs;

revoke update (retention_days) on orgs from webhook_billing;
revoke select (id, retention_days) on orgs from webhook_billing;
drop policy if exists orgs_billing_update on orgs;

alter table orgs drop constraint if exists orgs_retention_days_positive;
alter table orgs drop column if exists retention_days;
