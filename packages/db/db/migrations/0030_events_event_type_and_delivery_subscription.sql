-- migrate:up

-- S3 Slice 3 PR2c (native auto-delivery wiring). Two additive facts:
--   1. events.event_type — the normalized, per-provider-derived event type (Stripe body `.type`, GitHub
--      `x-github-event` header, ...). NULLABLE (like provider/method): null = unextracted, which the
--      subscription matcher routes via `*` only. EXPAND-only, no backfill — only forward routing reads it.
--   2. delivery_attempts.subscription_id — which subscription produced an auto-delivery (null = a manual
--      events.replay, not subscription-driven). Composite FK (subscription_id, org_id) ->
--      delivery_subscriptions(id, org_id). Composite (cross-org defense-in-depth, like the event_id/
--      destination_id FKs). NO ON DELETE action (default NO ACTION) — a bare SET NULL on a composite FK
--      would also null the NOT NULL org_id and ABORT the delete (the hazard 0025 documents), and the
--      Postgres-15+ column-list `SET NULL (subscription_id)` form isn't portable to the test runtime. Instead,
--      deleting a subscription must NOT delete its in-flight deliveries — deleteSubscription UNLINKS them
--      (sets subscription_id = null) in the same tx BEFORE the delete, so the FK is satisfied. Nullable.
-- RLS is row-based (the existing events/delivery_attempts policies cover the new columns); metering is
-- unchanged (event_type changes no event count; a delivery is not a billable event).
alter table events add column event_type text;
alter table delivery_attempts add column subscription_id uuid;
alter table delivery_attempts
  add constraint delivery_attempts_subscription_fk
  foreign key (subscription_id, org_id) references delivery_subscriptions (id, org_id);

-- Unlink-on-delete via a BEFORE DELETE trigger (NOT ON DELETE SET NULL, which would null the NOT NULL
-- org_id too on a composite FK; the PG15+ column-list `SET NULL (subscription_id)` form isn't portable to
-- the test runtime). This nulls only subscription_id on any linked delivery_attempts whenever a subscription
-- is deleted — directly (deleteSubscription) OR transitively (a future hard-delete of the source endpoint /
-- destination cascades to the subscription per 0029). security invoker: runs as the deleting role under its
-- RLS, so it only touches that org's deliveries. The delivery rows survive the unlink (they finish on their
-- own); subscription_id is informational (which sub produced the delivery), so null = "sub since removed".
create function unlink_subscription_deliveries() returns trigger
  language plpgsql
  security invoker
  as $$
begin
  update delivery_attempts set subscription_id = null where subscription_id = old.id;
  return old;
end
$$;

create trigger delivery_subscriptions_unlink_before_delete
  before delete on delivery_subscriptions
  for each row execute function unlink_subscription_deliveries();

-- ingest_event gains p_event_type, APPENDED LAST (after 0028's p_method) so existing positional callers
-- keep binding via the trailing default; insertIngestEvent binds all 18 args explicitly. A function's
-- input-arg-type list is its identity, so a new parameter can't be added with CREATE OR REPLACE (that
-- makes an overload alongside 0028's 17-arg function). DROP the exact 17-arg signature, CREATE the 18-arg
-- one (body byte-identical to 0028 except event_type is added to the INSERT), then re-GRANT.
drop function ingest_event(
  uuid, uuid, uuid, text, bigint, text, text, text, bytea, jsonb, text, text, bigint,
  text, boolean, jsonb, text
);

create function ingest_event(
  p_id uuid,
  p_org_id uuid,
  p_endpoint_id uuid,
  p_payload_r2_key text,
  p_payload_bytes bigint,
  p_dedup_key text,
  p_dedup_strategy text,
  p_content_type text default null,
  p_content_hash bytea default null,
  p_headers jsonb default '[]'::jsonb,
  p_provider text default null,
  p_provider_event_id text default null,
  p_dedup_bucket bigint default null,
  p_external_id text default null,
  p_verified boolean default false,
  p_verification jsonb default null,
  p_method text default null,
  p_event_type text default null
) returns table (event_id uuid, inserted boolean)
  language plpgsql
  security invoker
  as $$
declare
  v_count bigint;
begin
  perform set_config('app.current_org', p_org_id::text, true);
  insert into events (
    id, org_id, endpoint_id, payload_r2_key, payload_bytes, dedup_key, dedup_strategy,
    content_type, content_hash, headers, provider, provider_event_id, dedup_bucket,
    external_id, verified, verification, method, event_type
  )
  values (
    p_id, p_org_id, p_endpoint_id, p_payload_r2_key, p_payload_bytes, p_dedup_key,
    p_dedup_strategy, p_content_type, p_content_hash, coalesce(p_headers, '[]'::jsonb),
    p_provider, p_provider_event_id, p_dedup_bucket, p_external_id,
    coalesce(p_verified, false), p_verification, p_method, p_event_type
  )
  on conflict (endpoint_id, dedup_key) do nothing;
  get diagnostics v_count = row_count;
  event_id := p_id;
  inserted := (v_count = 1);
  return next;
end
$$;

grant execute on function ingest_event(
  uuid, uuid, uuid, text, bigint, text, text, text, bytea, jsonb, text, text, bigint,
  text, boolean, jsonb, text, text
) to webhook_app, webhook_ingest;

-- migrate:down

-- Restore 0028's 17-arg ingest_event verbatim, then drop the FK + columns. (up->down->up is exercised by
-- migrations.test.ts.)
drop function ingest_event(
  uuid, uuid, uuid, text, bigint, text, text, text, bytea, jsonb, text, text, bigint,
  text, boolean, jsonb, text, text
);

create function ingest_event(
  p_id uuid,
  p_org_id uuid,
  p_endpoint_id uuid,
  p_payload_r2_key text,
  p_payload_bytes bigint,
  p_dedup_key text,
  p_dedup_strategy text,
  p_content_type text default null,
  p_content_hash bytea default null,
  p_headers jsonb default '[]'::jsonb,
  p_provider text default null,
  p_provider_event_id text default null,
  p_dedup_bucket bigint default null,
  p_external_id text default null,
  p_verified boolean default false,
  p_verification jsonb default null,
  p_method text default null
) returns table (event_id uuid, inserted boolean)
  language plpgsql
  security invoker
  as $$
declare
  v_count bigint;
begin
  perform set_config('app.current_org', p_org_id::text, true);
  insert into events (
    id, org_id, endpoint_id, payload_r2_key, payload_bytes, dedup_key, dedup_strategy,
    content_type, content_hash, headers, provider, provider_event_id, dedup_bucket,
    external_id, verified, verification, method
  )
  values (
    p_id, p_org_id, p_endpoint_id, p_payload_r2_key, p_payload_bytes, p_dedup_key,
    p_dedup_strategy, p_content_type, p_content_hash, coalesce(p_headers, '[]'::jsonb),
    p_provider, p_provider_event_id, p_dedup_bucket, p_external_id,
    coalesce(p_verified, false), p_verification, p_method
  )
  on conflict (endpoint_id, dedup_key) do nothing;
  get diagnostics v_count = row_count;
  event_id := p_id;
  inserted := (v_count = 1);
  return next;
end
$$;

grant execute on function ingest_event(
  uuid, uuid, uuid, text, bigint, text, text, text, bytea, jsonb, text, text, bigint,
  text, boolean, jsonb, text
) to webhook_app, webhook_ingest;

drop trigger delivery_subscriptions_unlink_before_delete on delivery_subscriptions;
drop function unlink_subscription_deliveries();
alter table delivery_attempts drop constraint delivery_attempts_subscription_fk;
alter table delivery_attempts drop column subscription_id;
alter table events drop column event_type;
