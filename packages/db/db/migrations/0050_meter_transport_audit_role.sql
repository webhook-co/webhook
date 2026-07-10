-- migrate:up

-- WS1 Stripe TRANSPORT reconciliation (money-correctness). The existing F6 oracle (webhook_meter_audit,
-- 0046) recounts OUR events vs OUR frozen `usage` — it validates our count against our own source. It cannot
-- see whether the meter events we POSTed to Stripe were actually AGGREGATED on Stripe's side: the outbox
-- `sent` state only means "Stripe returned 2xx", and `stripe_meter_event_id` is just our echoed identifier.
-- A meter event Stripe silently dropped = usage we can never bill, invisible until an invoice looks wrong.
--
-- This role reads what we TOLD Stripe (the outbox `sent` rows) plus the org→Stripe-customer map, so a cron
-- can compare them to Stripe's event-summary aggregates. It is deliberately DISTINCT from webhook_meter_audit:
-- that role's contract is "counts rows, never reads identifiers", but the transport reconciler must read
-- `billing_customers.stripe_customer_id` — an EXTERNAL billing identifier it sends off-box to Stripe, a
-- different data class. A separate least-privilege role keeps the recount role's story clean and lets the
-- transport check dark-gate independently (its own Hyperdrive). NON-OWNER, NOSUPERUSER, NOBYPASSRLS, read-only.
-- Login password injected out of band (Neon), never a literal here; created idempotently for local/CI + prod.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'webhook_meter_transport') then
    create role webhook_meter_transport login nosuperuser nobypassrls nocreatedb nocreaterole;
  end if;
end
$$;

grant usage on schema public to webhook_meter_transport;

-- Role-targeted SELECT policies (the cross-org read gate). stripe_meter_reports and billing_customers are
-- FORCE RLS, so even the owner is policed; these permissive policies are scoped to THIS role only, leaving
-- webhook_app's per-org policies intact.
create policy stripe_meter_reports_transport_select on stripe_meter_reports
  for select to webhook_meter_transport using (true);
create policy billing_customers_transport_select on billing_customers
  for select to webhook_meter_transport using (true);

-- COLUMN grants (least privilege). Outbox: exactly the value we POSTed per (org, day) + its send markers —
-- (org_id, day, event_count, status, sent_at); NEVER the internal identifier or stripe_meter_event_id.
-- billing_customers: ONLY (org_id, stripe_customer_id) — the org→Stripe map; never created_at or anything
-- else. No write anywhere.
grant select (org_id, day, event_count, status, sent_at) on stripe_meter_reports to webhook_meter_transport;
grant select (org_id, stripe_customer_id) on billing_customers to webhook_meter_transport;

-- migrate:down

-- Roles are CLUSTER-GLOBAL — drop it (guarded + grants revoked first, a role holding privileges can't drop),
-- mirroring every other role migration so the reversibility suite's "no leftover roles" assertion isn't blind.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'webhook_meter_transport') then
    revoke select (org_id, stripe_customer_id) on billing_customers from webhook_meter_transport;
    revoke select (org_id, day, event_count, status, sent_at) on stripe_meter_reports from webhook_meter_transport;
    drop policy if exists billing_customers_transport_select on billing_customers;
    drop policy if exists stripe_meter_reports_transport_select on stripe_meter_reports;
    revoke usage on schema public from webhook_meter_transport;
    drop role webhook_meter_transport;
  end if;
end
$$;
