-- migrate:up

-- S8 Slice 1 (accept-all-verbs): record the captured request's HTTP method as a first-class fact on
-- the event. `method` is a NULLABLE fact column (like `verified`/`provider`) — it stores an observed
-- attribute, never a billing verdict. EXPAND-only: additive, no default, no backfill. Legacy rows
-- (pre-migration — all POST under the old POST-only gate) honestly report NULL ("unrecorded") rather
-- than an inferred 'POST'. RLS is row-based (the existing events policies cover the new column); the
-- table-level INSERT/SELECT grant to webhook_ingest (0003) already covers it; metering stays
-- single-dimension (the column changes no event count, and dedup is unchanged).
alter table events add column method text;

-- ingest_event gains p_method, APPENDED LAST so existing 7-arg positional callers (the benchmark and
-- rls.test.ts calls) keep binding via the trailing default; the insertIngestEvent wrapper now binds all
-- 17 args explicitly. A function's input-arg-type list is part of its identity, so a new parameter CANNOT be added with
-- CREATE OR REPLACE — that would create a 17-arg OVERLOAD alongside 0006's 16-arg function (ambiguous
-- calls, two grants). So we DROP the exact 16-arg signature and CREATE the 17-arg one, then re-GRANT.
-- The body is byte-identical to 0006 except `method` is added to the INSERT column list and bound from
-- p_method. The webhook_ingest role statement_timeouts set in 0006 are untouched here.
drop function ingest_event(
  uuid, uuid, uuid, text, bigint, text, text, text, bytea, jsonb, text, text, bigint,
  text, boolean, jsonb
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

-- migrate:down

-- Restore 0006's 16-arg ingest_event verbatim, then drop the column. (Reversibility is exercised by
-- the up->down->up run in migrations.test.ts.)
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
  p_verification jsonb default null
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
    external_id, verified, verification
  )
  values (
    p_id, p_org_id, p_endpoint_id, p_payload_r2_key, p_payload_bytes, p_dedup_key,
    p_dedup_strategy, p_content_type, p_content_hash, coalesce(p_headers, '[]'::jsonb),
    p_provider, p_provider_event_id, p_dedup_bucket, p_external_id,
    coalesce(p_verified, false), p_verification
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
  text, boolean, jsonb
) to webhook_app, webhook_ingest;

alter table events drop column method;
