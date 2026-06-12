-- migrate:up

-- The unauthenticated ingest hot path as ONE statement (plan §0.2, H5, ADR-0012).
-- The caller runs `SELECT * FROM ingest_event(...)` — a single top-level statement,
-- so the whole body executes in one implicit transaction. set_config(..., true)
-- scopes app.current_org to that implicit transaction (auto-reset on completion, no
-- connection pinning on Hyperdrive's pooled connections).
--
-- SECURITY INVOKER (runs as the caller, webhook_ingest or webhook_app): combined with
-- FORCE ROW LEVEL SECURITY on events and a NON-OWNER caller, the insert is genuinely
-- RLS-enforced — there is no definer/owner bypass, and it fails safe (without grants
-- it errors rather than silently bypassing policies). org_id is SERVER-derived (from
-- the token lookup), never client input. received_at is set by the events trigger
-- (H5), not here and not at the edge. The insert is ON CONFLICT (endpoint_id,
-- dedup_key) DO NOTHING: a conflict is the dedup no-op success path. ON CONFLICT
-- requires SELECT on events (the arbiter), so webhook_ingest is granted INSERT+SELECT
-- (see 0003) — still non-owner and RLS-enforced. inserted is reported from the
-- row_count diagnostic (not RETURNING).

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

-- H5: bound how long any ingest statement can run on the ingest role. The tunnel's
-- safety-lag watermark δ is derived from this (δ >= statement_timeout), so no
-- in-flight ingest can still be writing a received_at older than the watermark. The
-- millisecond value is mirrored in packages/shared (INGEST_STATEMENT_TIMEOUT_MS) and
-- asserted consistent by a test. idle_in_transaction guards a pinned pooled
-- connection (ingest is single-statement, so this is hygiene/defense-in-depth).
alter role webhook_ingest set statement_timeout = '5s';
alter role webhook_ingest set idle_in_transaction_session_timeout = '5s';

-- migrate:down

alter role webhook_ingest reset statement_timeout;
alter role webhook_ingest reset idle_in_transaction_session_timeout;
drop function if exists ingest_event(
  uuid, uuid, uuid, text, bigint, text, text, text, bytea, jsonb, text, text, bigint,
  text, boolean, jsonb
);
