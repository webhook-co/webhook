-- migrate:up

-- S4.4c outbound metering. The meter-reporter cron (runs in the metering cron, gated on BILLING_MODE)
-- reports each org's finalized daily usage to a Stripe Billing Meter through the stripe_meter_reports
-- outbox. It processes each org PER-ORG under webhook_app RLS (reads finalized `usage` + its Stripe
-- customer id, inserts/updates its own outbox rows). Only the cross-org ENUMERATION of PAYING orgs needs
-- a new grant — extend webhook_meter (SELECT-only, migrations 0040/0042) with the billing_subscriptions
-- keys it must scan to know which orgs report to Stripe (Free orgs never report). No write is granted.

-- Role-targeted SELECT policy (FOR SELECT TO webhook_meter only) — the tenant policy stays org-scoped.
create policy billing_subscriptions_meter_select on billing_subscriptions
  for select to webhook_meter using (true);

-- COLUMN grants (least privilege): only the enumeration keys — the org, its lifecycle status (to skip
-- fully-canceled orgs), the period bounds (the billing period the reporter attributes days to), and
-- created_at (the meter FLOOR: never report a day earlier than the org subscribed, so pre-subscription
-- Free usage is not billed). NOT stripe_subscription_id (the external id) / plan / event_cap.
grant select (org_id, status, current_period_start, current_period_end, created_at)
  on billing_subscriptions to webhook_meter;

-- migrate:down

revoke select (org_id, status, current_period_start, current_period_end, created_at)
  on billing_subscriptions from webhook_meter;
drop policy if exists billing_subscriptions_meter_select on billing_subscriptions;
