-- migrate:up

-- S4.5a Stripe inbound webhook RECEIVER. Two objects the receiver needs (the state-sync handlers that
-- write billing_customers/subscriptions/org_limits land in S4.5b, widening the role's grants there):
--
--   1. processed_stripe_events — the replay-dedup ledger. Stripe's public event.id (evt_…) is globally
--      unique and an event is NOT org-scoped at receipt (the org is resolved from SIGNED metadata INSIDE
--      the handler, only AFTER the signature verifies), so this is a GLOBAL ledger — dedup must run before
--      org resolution. It is RLS-EXEMPT (like the auth identity tables): it has no org_id to scope by, and
--      access is controlled purely by GRANT to the single writer role. The FIRST write after verify is an
--      insert-wins here; `on conflict do nothing` returning 0 rows = a replay → ACK 200, no side effects.
--
--   2. webhook_billing — the dedicated VERIFIED-STRIPE-ONLY writer role. billing_customers/subscriptions
--      are SELECT-only for webhook_app (0044); the inbound webhook is the ONLY writer, running as this role
--      after it verifies the Stripe signature and resolves org from signed metadata. S4.5a grants it just
--      the dedup ledger; S4.5b widens it to the billing tables + org_limits (cap mirror). NON-OWNER,
--      NOSUPERUSER, NOBYPASSRLS; created idempotently (local/CI trust auth + managed prod both work); the
--      login password is injected out of band, never a literal here.

create table processed_stripe_events (
  event_id text primary key, -- Stripe's public evt_… id (globally unique) — the idempotency key
  event_type text not null,
  event_created bigint not null, -- Stripe's event.created (unix seconds) — the out-of-order watermark source
  received_at timestamptz not null default now()
);
-- No RLS: a global, non-org ledger (see above). Access is by GRANT to the one writer role only. Recorded in
-- the rls.test RLS_EXEMPT allowlist alongside the auth identity tables.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'webhook_billing') then
    create role webhook_billing login nosuperuser nobypassrls nocreatedb nocreaterole;
  end if;
end
$$;

grant usage on schema public to webhook_billing;
grant select, insert on processed_stripe_events to webhook_billing;

-- migrate:down

revoke select, insert on processed_stripe_events from webhook_billing;
drop table if exists processed_stripe_events;
-- Leave the role in place on down (mirrors 0033/0046 — dropping a login role that owns nothing is safe but
-- unnecessary, and other environments may share it).
