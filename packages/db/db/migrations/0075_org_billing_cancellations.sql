-- migrate:up

-- Durable outbox for canceling an org's Stripe subscription AFTER the org is hard-deleted.
--
-- The problem this fixes: deleteOrgWithAudit hard-deletes the org and every org_id child table
-- CASCADEs — including billing_subscriptions. Nothing ever told Stripe, so a paying customer who
-- deletes their account (or an owner who deletes a paid org) keeps being charged, and the local
-- row that would let anyone reconcile it is gone. Canceling inline is unsafe: the delete path is a
-- loop of separate transactions plus a cross-worker RPC, so a cancel-then-DB-fail would leave a
-- live org with a canceled subscription — which effectiveBillingPeriod drops to the exhausted Free
-- lifetime basis, and the cap producer then PAUSES that paying customer's ingest.
--
-- So the cancellation is enqueued in the SAME transaction as the org delete (webhook_app captures
-- the live stripe_subscription_id before the CASCADE destroys billing_subscriptions), and a cron
-- drains it against Stripe. Erasure never blocks on a Stripe outage; the drain is idempotent
-- (Stripe's resource_missing / already-canceled are treated as success). Mirrors org_deletions
-- (0051): FK-free so the row outlives the org it describes, RLS-forced, webhook_app enqueues its
-- own org's row, a dedicated cross-org cron role drains.
create table org_billing_cancellations (
  org_id uuid primary key,
  stripe_subscription_id text not null,
  status text not null default 'pending' check (status in ('pending', 'canceled', 'failed')),
  attempts integer not null default 0,
  requested_at timestamptz not null default now(),
  canceled_at timestamptz,
  last_error text
);

alter table org_billing_cancellations enable row level security;
alter table org_billing_cancellations force row level security;

-- webhook_app enqueues the job in the same transaction as the org delete (org_id is its RLS-pinned
-- org) and may read back only its own org's job. The insert `with check (org_id = current_org_id())`
-- is the boundary: a tenant cannot enqueue a cancellation for a subscription that isn't theirs.
grant insert, select on org_billing_cancellations to webhook_app;
-- The insert check pins BOTH the org (a tenant can only enqueue for its own org) AND the subscription:
-- the stripe_subscription_id must be one that exists in the org's OWN billing_subscriptions. The billing
-- subquery is itself RLS-scoped to current_org_id() for webhook_app, so a tenant cannot enqueue a
-- cancellation carrying ANOTHER org's subscription id (which the drain would otherwise cancel). Defense
-- in depth: the only code that inserts is deleteOrgWithAudit, which reads the org's own live sub — but a
-- forged foreign sub id must be unrepresentable at the RLS boundary, not merely unused by today's callers.
create policy org_billing_cancellations_app_insert on org_billing_cancellations
  for insert to webhook_app with check (
    org_id = current_org_id()
    and stripe_subscription_id in (select stripe_subscription_id from billing_subscriptions)
  );
create policy org_billing_cancellations_app_select on org_billing_cancellations
  for select to webhook_app using (org_id = current_org_id());

-- webhook_billing: the VERIFIED-STRIPE-ONLY role (0047) already holds the Stripe secret in the
-- apps/api hourly cron and reads billing_subscriptions cross-org for the retention reconciler. It
-- drains this outbox the same way: column-scoped SELECT to find pending jobs + the subscription id
-- to cancel, column-scoped UPDATE to advance status/attempts/last_error/canceled_at. No INSERT, no
-- DELETE. Least privilege: it reads only the columns it needs (ordering by requested_at), and never
-- touches a completed row (the `status = 'pending'` update policy).
grant select (org_id, stripe_subscription_id, status, attempts, requested_at)
  on org_billing_cancellations to webhook_billing;
grant update (status, attempts, canceled_at, last_error)
  on org_billing_cancellations to webhook_billing;
create policy org_billing_cancellations_billing_select on org_billing_cancellations
  for select to webhook_billing using (true);
create policy org_billing_cancellations_billing_update on org_billing_cancellations
  for update to webhook_billing using (status = 'pending')
  with check (status in ('pending', 'canceled', 'failed'));

-- The drain scans pending jobs oldest-first; partial index keeps it index-driven.
create index org_billing_cancellations_pending_idx
  on org_billing_cancellations (requested_at) where status = 'pending';

-- migrate:down

drop index if exists org_billing_cancellations_pending_idx;
drop policy if exists org_billing_cancellations_billing_update on org_billing_cancellations;
drop policy if exists org_billing_cancellations_billing_select on org_billing_cancellations;
drop policy if exists org_billing_cancellations_app_select on org_billing_cancellations;
drop policy if exists org_billing_cancellations_app_insert on org_billing_cancellations;
revoke all on org_billing_cancellations from webhook_billing;
revoke all on org_billing_cancellations from webhook_app;
drop table if exists org_billing_cancellations;
