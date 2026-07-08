-- migrate:up

-- S4.5b widens the webhook_billing writer role from the dedup ledger (0047) to the billing STATE it syncs
-- from VERIFIED Stripe events: the org↔customer link (billing_customers), the subscription mirror
-- (billing_subscriptions), and the org_limits cap mirror the soft-cap producer enforces. Those tables are
-- SELECT-only for webhook_app (0044) — the inbound webhook is the sole writer. It runs UNDER the resolved
-- org's RLS context (withTenant, org resolved from the SIGNED Stripe metadata WE set at checkout), so the
-- writes are confined to that one org by the org-scoped policies below; webhook_app still cannot write (it
-- has no INSERT/UPDATE grant — SELECT-only), so the grant is the gate and the policy is the confinement.
--
-- A monotonic watermark (billing_subscriptions.last_stripe_event_created) makes out-of-order Stripe
-- deliveries idempotent per subscription: an event whose created ≤ the last applied is ignored.

-- billing_customers: the org↔customer link write path (org-scoped, like org_limits).
create policy billing_customers_write_insert on billing_customers
  for insert with check (org_id = current_org_id());
create policy billing_customers_write_update on billing_customers
  for update using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update on billing_customers to webhook_billing;

-- billing_subscriptions: the subscription mirror + the out-of-order watermark. No DELETE (history lives in
-- Stripe; a cancellation is a status/downgrade, not a row drop).
alter table billing_subscriptions
  add column last_stripe_event_created bigint not null default 0;
create policy billing_subscriptions_write_insert on billing_subscriptions
  for insert with check (org_id = current_org_id());
create policy billing_subscriptions_write_update on billing_subscriptions
  for update using (org_id = current_org_id()) with check (org_id = current_org_id());
grant select, insert, update on billing_subscriptions to webhook_billing;

-- org_limits: the cap mirror (the cap-producer reads event_cap). Its org-scoped policies already exist
-- (0004); webhook_billing needs the grant. DELETE too: a subscription.deleted downgrade REMOVES the paid
-- cap row so the org falls back to the injected Free default (the producer uses defaultEventCap when there
-- is no org_limits row) — an "explicit Free default" is the absence of a paid mirror, not a sentinel value.
grant select, insert, update, delete on org_limits to webhook_billing;

-- migrate:down

revoke select, insert, update, delete on org_limits from webhook_billing;
revoke select, insert, update on billing_subscriptions from webhook_billing;
drop policy if exists billing_subscriptions_write_update on billing_subscriptions;
drop policy if exists billing_subscriptions_write_insert on billing_subscriptions;
alter table billing_subscriptions drop column if exists last_stripe_event_created;
revoke select, insert, update on billing_customers from webhook_billing;
drop policy if exists billing_customers_write_update on billing_customers;
drop policy if exists billing_customers_write_insert on billing_customers;
