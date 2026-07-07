-- migrate:up

-- S4.4 billing schema (Stripe outbound, test-mode). Three org-scoped tables, RLS-native like the metering
-- tables (0004). NO prices/tiers live here — `plan` is a tier NAME, `event_cap` is the org's own included
-- count; the money figures live in Stripe + the internal repo. All writes are webhook_app under withTenant
-- (Checkout creates the customer for the authed org; the inbound webhook syncs subscription state after
-- resolving org from metadata.org_id). Enforcement still reads org_limits — the webhook mirrors a plan's
-- event_cap into org_limits so the SAME cap-producer path pauses; billing_subscriptions is the Stripe view.

-- billing_customers: the org ↔ Stripe customer link (one customer per org). stripe_customer_id is unique so
-- an inbound webhook can resolve org from the customer id; we NEVER key on email.
--
-- webhook_app (the tenant role) gets SELECT ONLY. stripe_customer_id is a GLOBALLY-UNIQUE, EXTERNAL
-- (Stripe-assigned) id that can't be bound to org_id by a CHECK — so if a tenant could INSERT/UPDATE it,
-- it could pre-claim another org's 'cus_…' under its OWN org_id (RLS only checks org_id) and either block
-- the victim from linking or mis-route the victim's billing events (the webhook resolves org by this id).
-- The WRITE path is therefore verified-Stripe-only, added in S4.4b via a dedicated writer (a billing role
-- / SECURITY DEFINER upsert) that resolves org from the SIGNED metadata.org_id — never a tenant write.
create table billing_customers (
  org_id uuid primary key references orgs (id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at timestamptz not null default now()
);
alter table billing_customers enable row level security;
alter table billing_customers force row level security;
create policy billing_customers_select on billing_customers for select using (org_id = current_org_id());
grant select on billing_customers to webhook_app;

-- billing_subscriptions: the org's CURRENT subscription state, synced from Stripe by the inbound webhook
-- (S4.5). One current subscription per org (org_id PK); history lives in Stripe. `status` is Stripe's
-- subscription status (free text — Stripe's enum can grow; the app validates, no migration-locked CHECK).
-- `event_cap` = the plan's included events (null = an unlimited plan); the webhook mirrors it into org_limits
-- so the existing cap-producer enforces it. period bounds anchor the billing period (they replace the UTC-
-- calendar-month default in currentBillingPeriod once a subscription exists). cancel_at_period_end is a
-- SCHEDULED flag — the org keeps its plan until current_period_end; only subscription.deleted downgrades.
create table billing_subscriptions (
  org_id uuid primary key references orgs (id) on delete cascade,
  stripe_subscription_id text not null unique,
  plan text not null,
  status text not null,
  event_cap bigint,
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table billing_subscriptions enable row level security;
alter table billing_subscriptions force row level security;
-- SELECT ONLY for webhook_app (tenant reads its own plan/status). stripe_subscription_id is the same
-- globally-unique external-id pre-claim risk as billing_customers.stripe_customer_id — a tenant write could
-- squat another org's 'sub_…'. Writes are verified-Stripe-only (S4.4b writer role resolving signed org_id).
create policy billing_subscriptions_select on billing_subscriptions for select using (org_id = current_org_id());
grant select on billing_subscriptions to webhook_app;

-- stripe_meter_reports: the outbox ledger (money-correctness guard F5) for reporting metered usage to
-- Stripe. One row per (org, UTC day) — the meter-reporter cron (S4.4c) marks a finalized day pending →
-- sending → sent, using `identifier = {org}:{day}` as Stripe's own idempotency key so a retry inside
-- Stripe's 24h window is a no-op. `status` is OUR state machine (stable → a CHECK is appropriate).
-- event_count is the value reported. stripe_meter_event_id records Stripe's ack. Append-then-update:
-- webhook_app gets INSERT/UPDATE/SELECT, no DELETE (an outbox row is durable evidence of what was reported).
create table stripe_meter_reports (
  org_id uuid not null references orgs (id) on delete cascade,
  day date not null,
  -- event_count is the value reported to Stripe — it must never be negative (a negative meter event would
  -- corrupt the org's billed usage). Guard it at the DB, not just the reporter code.
  event_count bigint not null check (event_count >= 0),
  -- identifier is Stripe's idempotency key = {org}:{day}. It is UNIQUE, but RLS only checks org_id on an
  -- insert — so WITHOUT the binding CHECK below a tenant could insert '{otherOrg}:{day}' under its OWN
  -- context and pre-claim (unique) another org's outbox slot, a cross-tenant metering-sabotage vector. The
  -- CHECK pins identifier to THIS row's (org_id, day), so a tenant can only ever write its own key. (A
  -- GENERATED column would be even stronger but `day::text` isn't IMMUTABLE, which generated columns require;
  -- a CHECK permits the stable cast and the app writes the SAME value the reporter uses for Stripe.)
  identifier text not null unique check (identifier = org_id::text || ':' || day::text),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent')),
  stripe_meter_event_id text,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  primary key (org_id, day)
);
alter table stripe_meter_reports enable row level security;
alter table stripe_meter_reports force row level security;
create policy stripe_meter_reports_select on stripe_meter_reports for select using (org_id = current_org_id());
create policy stripe_meter_reports_insert on stripe_meter_reports for insert with check (org_id = current_org_id());
create policy stripe_meter_reports_update on stripe_meter_reports for update using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update on stripe_meter_reports to webhook_app;
-- The retry scan (outbox rows not yet 'sent') — a small partial index so the reporter doesn't full-scan.
create index stripe_meter_reports_unsent_idx on stripe_meter_reports (org_id, day) where status <> 'sent';

-- migrate:down

drop table if exists stripe_meter_reports;
drop table if exists billing_subscriptions;
drop table if exists billing_customers;
