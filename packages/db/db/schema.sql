\restrict ybotiBi0vIcmtJfFPUvQnT1UdXKJ6IJL3HkXK5GhZMLzvUINEGH3s2ZtqwcNHRp

-- Dumped from database version 14.23 (Homebrew)
-- Dumped by pg_dump version 14.23 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: audit_log_chain(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_log_chain() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  prev_seq bigint;
  prev_row_hash bytea;
begin
  new.created_at := now();
  select a.seq, a.row_hash into prev_seq, prev_row_hash
    from audit_log a
    where a.org_id = new.org_id
    order by a.seq desc
    limit 1;
  if prev_seq is null then
    if new.seq <> 1 then
      raise exception 'audit chain for org % must start at seq 1 (got %)', new.org_id, new.seq
        using errcode = 'check_violation';
    end if;
    if new.prev_hash is not null then
      raise exception 'audit genesis row (seq 1) must have null prev_hash'
        using errcode = 'check_violation';
    end if;
  else
    if new.seq <> prev_seq + 1 then
      raise exception 'audit seq must be contiguous for org %: expected % got %',
        new.org_id, prev_seq + 1, new.seq
        using errcode = 'check_violation';
    end if;
    if new.prev_hash is distinct from prev_row_hash then
      raise exception 'audit prev_hash must equal the prior row_hash for org %', new.org_id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end
$$;


--
-- Name: audit_log_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_log_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'audit_log is append-only: % is not permitted', tg_op
    using errcode = 'check_violation';
end
$$;


--
-- Name: auth_audit_event_chain(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_audit_event_chain() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  prev_seq bigint;
  prev_row_hash bytea;
begin
  new.created_at := now();
  select a.seq, a.row_hash into prev_seq, prev_row_hash
    from auth_audit_event a
    where a.org_id = new.org_id
    order by a.seq desc
    limit 1;
  if prev_seq is null then
    if new.seq <> 1 then
      raise exception 'auth_audit_event chain for org % must start at seq 1 (got %)', new.org_id, new.seq
        using errcode = 'check_violation';
    end if;
    if new.prev_hash is not null then
      raise exception 'auth_audit_event genesis row (seq 1) must have null prev_hash'
        using errcode = 'check_violation';
    end if;
  else
    if new.seq <> prev_seq + 1 then
      raise exception 'auth_audit_event seq must be contiguous for org %: expected % got %',
        new.org_id, prev_seq + 1, new.seq
        using errcode = 'check_violation';
    end if;
    if new.prev_hash is distinct from prev_row_hash then
      raise exception 'auth_audit_event prev_hash must equal the prior row_hash for org %', new.org_id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end
$$;


--
-- Name: auth_audit_event_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_audit_event_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'auth_audit_event is append-only: % is not permitted', tg_op
    using errcode = 'check_violation';
end
$$;


--
-- Name: current_app_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_app_user() RETURNS text
    LANGUAGE sql STABLE
    AS $$ select nullif(current_setting('app.current_user', true), '') $$;


--
-- Name: FUNCTION current_app_user(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.current_app_user() IS 'Current authenticated user for the org-directory policies. NULL when unset -> matches no rows.';


--
-- Name: current_org_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_org_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ select nullif(current_setting('app.current_org', true), '')::uuid $$;


--
-- Name: FUNCTION current_org_id(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.current_org_id() IS 'Current tenant for RLS policies. NULL when app.current_org is unset/blank -> deny-by-default.';


--
-- Name: current_user_profile(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_user_profile() RETURNS TABLE(name text, email text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    select u.name, u.email
      from "user" u
     where u.id = current_app_user()
  $$;


--
-- Name: events_stamp_received_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.events_stamp_received_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.received_at := now();
  return new;
end
$$;


--
-- Name: guard_billable_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_billable_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.billable is not distinct from old.billable then
    return new; -- the overwhelmingly common path (every retry / delivered / dead write): no usage read
  end if;
  if new.billable then
    raise exception 'delivery_attempts.billable may never be raised to true (row %)', old.id
      using errcode = 'check_violation';
  end if;
  -- The row's own UTC day, expressed as a containment test against usage's (org_id, window_start) PK —
  -- no date_trunc, so it cannot drift with the session TimeZone the way a truncation would.
  if exists (
    select 1 from usage u
     where u.org_id = old.org_id
       and u.finalized_at is not null
       and old.created_at >= u.window_start
       and old.created_at < u.window_start + interval '1 day'
  ) then
    new.billable := old.billable; -- frozen day: already billed, stays billed
  end if;
  return new;
end
$$;


--
-- Name: ingest_event(uuid, uuid, uuid, text, bigint, text, text, text, bytea, jsonb, text, text, bigint, text, boolean, jsonb, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ingest_event(p_id uuid, p_org_id uuid, p_endpoint_id uuid, p_payload_r2_key text, p_payload_bytes bigint, p_dedup_key text, p_dedup_strategy text, p_content_type text DEFAULT NULL::text, p_content_hash bytea DEFAULT NULL::bytea, p_headers jsonb DEFAULT '[]'::jsonb, p_provider text DEFAULT NULL::text, p_provider_event_id text DEFAULT NULL::text, p_dedup_bucket bigint DEFAULT NULL::bigint, p_external_id text DEFAULT NULL::text, p_verified boolean DEFAULT false, p_verification jsonb DEFAULT NULL::jsonb, p_method text DEFAULT NULL::text, p_event_type text DEFAULT NULL::text) RETURNS TABLE(event_id uuid, inserted boolean)
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: org_member_directory(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.org_member_directory() RETURNS TABLE(user_id text, name text, email text, role text, joined_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    select m.user_id, u.name, u.email, m.role, m.created_at
      from memberships m
      join "user" u on u.id = m.user_id
     where m.org_id = current_org_id()
     order by m.created_at asc
  $$;


--
-- Name: org_slug_reserved(public.citext); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.org_slug_reserved(s public.citext) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
    select s in (
      -- route segments under /org/{slug}/
      'dashboard', 'endpoints', 'events', 'deliveries', 'destinations', 'triggers',
      'credentials', 'settings', 'team', 'billing', 'usage', 'audit',
      -- routing + creation
      'org', 'orgs', 'new', 'api', 'admin', 'login', 'logout', 'auth', 'invite',
      -- framework / infra
      'static', '_next', 'well-known',
      -- brand + surfaces
      'webhook', 'wbhk', 'www', 'app', 'docs', 'play', 'get', 'status', 'support', 'help',
      'pricing', 'blog', 'security', 'legal'
    )
  $$;


--
-- Name: FUNCTION org_slug_reserved(s public.citext); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.org_slug_reserved(s public.citext) IS 'A slug that would shadow a route segment, surface, or brand name. Used by the orgs_slug_not_reserved CHECK.';


--
-- Name: orgs_slug_not_retired(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgs_slug_not_retired() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  begin
    if exists (
      select 1 from org_slug_history h
       where h.slug = new.slug and h.org_id is distinct from new.id
    ) then
      -- ⚠️ The CONSTRAINT option is not decoration. `raise … using errcode = 'unique_violation'` sets SQLSTATE
      -- 23505 but leaves the error's constraint field EMPTY — and apps/auth's collision retry
      -- (`isSlugCollision`) fires only when `constraint_name` contains "slug". Without this, a new user whose
      -- attempt-0 slug happens to equal a RETIRED one gets: trigger raises -> the retry does not recognise it
      -- -> bootstrapForUser rethrows -> the outer catch SWALLOWS it -> no org. And attempt 0 is deterministic,
      -- so every later self-heal re-derives the same doomed slug and fails identically. Forever. It is the
      -- exact brick the retry loop was written to prevent, reintroduced through a different door.
      raise exception 'slug % was retired and can never be reused', new.slug
        using errcode = 'unique_violation', constraint = 'orgs_slug_retired';
    end if;
    return new;
  end;
  $$;


--
-- Name: orgs_slug_record_history(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orgs_slug_record_history() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  begin
    if tg_op = 'DELETE' then
      insert into org_slug_history (slug, org_id) values (old.slug, old.id)
        on conflict (slug) do nothing;
      return old;
    end if;
    if new.slug is distinct from old.slug then
      insert into org_slug_history (slug, org_id) values (old.slug, old.id)
        on conflict (slug) do nothing;
    end if;
    return new;
  end;
  $$;


--
-- Name: rollup_delivery_stats(timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rollup_delivery_stats(p_window_start timestamp with time zone) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
declare
  v_window timestamptz := date_trunc('day', p_window_start);
  v_rows bigint;
begin
  insert into delivery_stats
    (org_id, window_start, delivered_count, dead_count, blocked_count, p95_duration_ms, updated_at)
  select
    d.org_id,
    v_window,
    count(*) filter (where d.status = 'delivered'),
    count(*) filter (where d.status = 'dead'),
    count(*) filter (where d.status = 'blocked'),
    -- FILTER on the ordered-set aggregate: p95 over only the delivered rows that carry a measured duration.
    -- null when there are none — never a fabricated 0.
    (percentile_cont(0.95) within group (order by d.duration_ms)
       filter (where d.status = 'delivered' and d.duration_ms is not null))::int,
    now()
  from delivery_attempts d
  where d.created_at >= v_window
    and d.created_at < v_window + interval '1 day'
  group by d.org_id
  on conflict (org_id, window_start) do update set
    delivered_count = excluded.delivered_count,
    dead_count = excluded.dead_count,
    blocked_count = excluded.blocked_count,
    p95_duration_ms = excluded.p95_duration_ms,
    updated_at = now();
  get diagnostics v_rows = row_count;
  return v_rows;
end
$$;


--
-- Name: rollup_usage(timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rollup_usage(p_window_start timestamp with time zone) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
declare
  v_window timestamptz := date_trunc('day', p_window_start);
  v_rows bigint;
begin
  insert into usage (org_id, window_start, event_count, updated_at, counts_deliveries, counts_only_billable)
  select s.org_id, v_window, sum(s.n), now(), true, true
  from (
    select e.org_id, count(*)::bigint as n
    from events e
    where e.received_at >= v_window
      and e.received_at < v_window + interval '1 day'
    group by e.org_id

    union all

    -- One row per BILLABLE DISPATCH. Retries mutate the row, they do not insert a new one.
    select d.org_id, count(*)::bigint as n
    from delivery_attempts d
    where d.created_at >= v_window
      and d.created_at < v_window + interval '1 day'
      and d.billable
    group by d.org_id
  ) s
  group by s.org_id
  on conflict (org_id, window_start)
  do update set event_count = excluded.event_count, updated_at = now(),
                counts_deliveries = true, counts_only_billable = true
    where usage.finalized_at is null;
  get diagnostics v_rows = row_count;
  return v_rows;
end
$$;


--
-- Name: unlink_subscription_deliveries(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.unlink_subscription_deliveries() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  update delivery_attempts set subscription_id = null where subscription_id = old.id;
  return old;
end
$$;


--
-- Name: usage_finalized_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.usage_finalized_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if old.finalized_at is not null
     and (new.event_count is distinct from old.event_count
          or new.finalized_at is distinct from old.finalized_at) then
    raise exception 'usage row (org %, window %) is finalized and immutable', old.org_id, old.window_start
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;


--
-- Name: user_org_directory(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_org_directory() RETURNS TABLE(org_id uuid, slug text, former_slugs text, name text, role text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    select m.org_id,
           o.slug::text,
           coalesce(
             (select string_agg(h.slug::text, ',' order by h.retired_at desc)
                from org_slug_history h
               where h.org_id = o.id and h.slug <> o.slug),
             ''
           ),
           o.name,
           m.role
      from memberships m
      join orgs o on o.id = m.org_id
     where m.user_id = current_app_user()
     order by m.created_at asc, m.org_id asc
  $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account (
    id text NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp with time zone,
    "refreshTokenExpiresAt" timestamp with time zone,
    scope text,
    password text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


--
-- Name: agent_triggers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_triggers (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    endpoint_id uuid NOT NULL,
    name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone
);

ALTER TABLE ONLY public.agent_triggers FORCE ROW LEVEL SECURITY;


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    key_hash bytea NOT NULL,
    prefix text NOT NULL,
    start text NOT NULL,
    name text NOT NULL,
    scopes jsonb DEFAULT '[]'::jsonb NOT NULL,
    expires_at timestamp with time zone,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    audience text,
    grant_id uuid,
    owner_type text DEFAULT 'user'::text NOT NULL,
    sso_authorized boolean,
    created_by text,
    CONSTRAINT api_keys_owner_type_check CHECK ((owner_type = ANY (ARRAY['user'::text, 'org'::text])))
);

ALTER TABLE ONLY public.api_keys FORCE ROW LEVEL SECURITY;


--
-- Name: apikey; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.apikey (
    id text NOT NULL,
    "configId" text NOT NULL,
    name text,
    start text,
    "referenceId" text NOT NULL,
    prefix text,
    key text NOT NULL,
    "refillInterval" integer,
    "refillAmount" integer,
    "lastRefillAt" timestamp with time zone,
    enabled boolean,
    "rateLimitEnabled" boolean,
    "rateLimitTimeWindow" integer,
    "rateLimitMax" integer,
    "requestCount" integer,
    remaining integer,
    "lastRequest" timestamp with time zone,
    "expiresAt" timestamp with time zone,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    permissions text,
    metadata text
);


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id bigint NOT NULL,
    org_id uuid NOT NULL,
    seq bigint NOT NULL,
    actor text,
    action text NOT NULL,
    target text,
    prev_hash bytea,
    row_hash bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.audit_log FORCE ROW LEVEL SECURITY;


--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_log_id_seq OWNED BY public.audit_log.id;


--
-- Name: auth_audit_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_audit_event (
    id bigint NOT NULL,
    org_id uuid NOT NULL,
    seq bigint NOT NULL,
    actor text,
    event_type text NOT NULL,
    target_id text,
    ip inet,
    geo jsonb,
    metadata jsonb,
    prev_hash bytea,
    row_hash bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.auth_audit_event FORCE ROW LEVEL SECURITY;


--
-- Name: auth_audit_event_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.auth_audit_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auth_audit_event_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.auth_audit_event_id_seq OWNED BY public.auth_audit_event.id;


--
-- Name: auth_grant; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_grant (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    user_id text NOT NULL,
    actor_type text DEFAULT 'user'::text NOT NULL,
    device_name text,
    device_fingerprint text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_ip inet,
    created_geo jsonb,
    last_used_at timestamp with time zone,
    last_used_ip inet,
    last_used_geo jsonb,
    status text NOT NULL,
    expires_at timestamp with time zone,
    auth_method text NOT NULL,
    sso_identity_id text,
    approved_by text,
    approved_at timestamp with time zone,
    revoked_by text,
    revoked_at timestamp with time zone,
    revocation_reason text,
    CONSTRAINT auth_grant_auth_method_check CHECK ((auth_method = ANY (ARRAY['pkce_loopback'::text, 'device_code'::text]))),
    CONSTRAINT auth_grant_status_check CHECK ((status = ANY (ARRAY['pending_approval'::text, 'active'::text, 'revoked'::text, 'expired'::text])))
);

ALTER TABLE ONLY public.auth_grant FORCE ROW LEVEL SECURITY;


--
-- Name: auth_refresh_token; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_refresh_token (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    grant_id uuid NOT NULL,
    audience text NOT NULL,
    token_hash bytea NOT NULL,
    prefix text NOT NULL,
    start text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    replaced_by uuid
);

ALTER TABLE ONLY public.auth_refresh_token FORCE ROW LEVEL SECURITY;


--
-- Name: auth_session_exchange; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_session_exchange (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    user_id text NOT NULL,
    audience text NOT NULL,
    token_hash bytea NOT NULL,
    prefix text NOT NULL,
    start text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone
);

ALTER TABLE ONLY public.auth_session_exchange FORCE ROW LEVEL SECURITY;


--
-- Name: billing_customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_customers (
    org_id uuid NOT NULL,
    stripe_customer_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.billing_customers FORCE ROW LEVEL SECURITY;


--
-- Name: billing_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_subscriptions (
    org_id uuid NOT NULL,
    stripe_subscription_id text NOT NULL,
    plan text NOT NULL,
    status text NOT NULL,
    event_cap bigint,
    current_period_start timestamp with time zone NOT NULL,
    current_period_end timestamp with time zone NOT NULL,
    cancel_at_period_end boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_stripe_event_created bigint DEFAULT 0 NOT NULL
);

ALTER TABLE ONLY public.billing_subscriptions FORCE ROW LEVEL SECURITY;


--
-- Name: delivery_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_attempts (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    event_id uuid NOT NULL,
    target text NOT NULL,
    idempotency_key text,
    status text NOT NULL,
    status_code integer,
    attempt integer DEFAULT 1 NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at timestamp with time zone,
    destination_id uuid,
    next_retry_at timestamp with time zone,
    subscription_id uuid,
    billable boolean DEFAULT true NOT NULL,
    duration_ms integer,
    CONSTRAINT delivery_attempts_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'forwarded'::text, 'pending'::text, 'delivered'::text, 'failed'::text, 'blocked'::text, 'dead'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY public.delivery_attempts FORCE ROW LEVEL SECURITY;


--
-- Name: delivery_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_stats (
    org_id uuid NOT NULL,
    window_start timestamp with time zone NOT NULL,
    delivered_count bigint DEFAULT 0 NOT NULL,
    dead_count bigint DEFAULT 0 NOT NULL,
    blocked_count bigint DEFAULT 0 NOT NULL,
    p95_duration_ms integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.delivery_stats FORCE ROW LEVEL SECURITY;


--
-- Name: delivery_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_subscriptions (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    source_endpoint_id uuid NOT NULL,
    destination_id uuid NOT NULL,
    provider text,
    event_types jsonb DEFAULT '["*"]'::jsonb NOT NULL,
    require_verified boolean DEFAULT false NOT NULL,
    channels jsonb DEFAULT '[]'::jsonb NOT NULL,
    filter jsonb,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.delivery_subscriptions FORCE ROW LEVEL SECURITY;


--
-- Name: endpoints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.endpoints (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    ingest_token_hash bytea NOT NULL,
    name text NOT NULL,
    paused boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    ingest_token_ciphertext bytea,
    ingest_token_wrapped_dek bytea,
    ingest_token_kek_ref text,
    ingest_token_enc_nonce bytea,
    ingest_token_enc_context jsonb,
    ingest_token_envelope_version smallint,
    ingest_key_id uuid,
    dedup_config jsonb
);

ALTER TABLE ONLY public.endpoints FORCE ROW LEVEL SECURITY;


--
-- Name: event_payload_purge; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_payload_purge (
    event_id uuid NOT NULL,
    org_id uuid NOT NULL,
    endpoint_id uuid NOT NULL,
    payload_r2_key text NOT NULL,
    status text DEFAULT 'purging'::text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    purge_completed_at timestamp with time zone,
    CONSTRAINT event_payload_purge_status_check CHECK ((status = ANY (ARRAY['purging'::text, 'completed'::text])))
);

ALTER TABLE ONLY public.event_payload_purge FORCE ROW LEVEL SECURITY;


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    endpoint_id uuid NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    payload_r2_key text NOT NULL,
    payload_r2_offset bigint,
    payload_bytes bigint NOT NULL,
    content_type text,
    content_hash bytea,
    headers jsonb DEFAULT '[]'::jsonb NOT NULL,
    dedup_key text NOT NULL,
    dedup_strategy text NOT NULL,
    provider text,
    provider_event_id text,
    dedup_bucket bigint,
    external_id text,
    verified boolean DEFAULT false NOT NULL,
    verification jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    method text,
    event_type text,
    deleted_at timestamp with time zone
);

ALTER TABLE ONLY public.events FORCE ROW LEVEL SECURITY;


--
-- Name: ingest_paused; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ingest_paused (
    org_id uuid NOT NULL,
    paused boolean DEFAULT false NOT NULL,
    reason text,
    since timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.ingest_paused FORCE ROW LEVEL SECURITY;


--
-- Name: memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memberships (
    org_id uuid NOT NULL,
    user_id text NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memberships_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])))
);

ALTER TABLE ONLY public.memberships FORCE ROW LEVEL SECURITY;


--
-- Name: notification_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_intents (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    kind text NOT NULL,
    destination_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    context jsonb,
    CONSTRAINT notification_intents_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text])))
);

ALTER TABLE ONLY public.notification_intents FORCE ROW LEVEL SECURITY;


--
-- Name: org_deletions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_deletions (
    org_id uuid NOT NULL,
    status text DEFAULT 'purging'::text NOT NULL,
    r2_cursor text,
    objects_purged bigint DEFAULT 0 NOT NULL,
    requested_by text,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    purge_completed_at timestamp with time zone,
    CONSTRAINT org_deletions_status_check CHECK ((status = ANY (ARRAY['purging'::text, 'completed'::text])))
);

ALTER TABLE ONLY public.org_deletions FORCE ROW LEVEL SECURITY;


--
-- Name: org_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_invites (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    token_hash bytea NOT NULL,
    start text NOT NULL,
    invited_email public.citext NOT NULL,
    role text NOT NULL,
    invited_by text,
    accepted_by text,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT org_invites_invited_email_check CHECK ((length(btrim((invited_email)::text)) > 0)),
    CONSTRAINT org_invites_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])))
);

ALTER TABLE ONLY public.org_invites FORCE ROW LEVEL SECURITY;


--
-- Name: org_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_limits (
    org_id uuid NOT NULL,
    event_cap bigint,
    pause_policy text DEFAULT 'pause'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT org_limits_pause_policy_check CHECK ((pause_policy = ANY (ARRAY['pause'::text, 'allow'::text])))
);

ALTER TABLE ONLY public.org_limits FORCE ROW LEVEL SECURITY;


--
-- Name: org_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_policy (
    org_id uuid NOT NULL,
    require_device_approval boolean,
    max_credential_ttl interval,
    allowed_scopes jsonb,
    force_reauth_interval interval,
    sso_required boolean,
    block_long_lived_keys boolean,
    max_long_lived_keys integer,
    require_mfa boolean,
    auto_approve_rules jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.org_policy FORCE ROW LEVEL SECURITY;


--
-- Name: org_slug_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_slug_history (
    slug public.citext NOT NULL,
    org_id uuid,
    retired_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.org_slug_history FORCE ROW LEVEL SECURITY;


--
-- Name: orgs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orgs (
    id uuid NOT NULL,
    slug public.citext NOT NULL,
    name text NOT NULL,
    region text DEFAULT 'us'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    retention_days integer,
    CONSTRAINT orgs_retention_days_positive CHECK (((retention_days IS NULL) OR (retention_days > 0))),
    CONSTRAINT orgs_slug_format CHECK ((((slug)::text ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'::text) AND ((slug)::text !~ '^[0-9]+$'::text) AND ((slug)::text = lower((slug)::text)))),
    CONSTRAINT orgs_slug_not_reserved CHECK ((NOT public.org_slug_reserved(slug)))
);

ALTER TABLE ONLY public.orgs FORCE ROW LEVEL SECURITY;


--
-- Name: processed_stripe_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.processed_stripe_events (
    event_id text NOT NULL,
    event_type text NOT NULL,
    event_created bigint NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_secrets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_secrets (
    id uuid NOT NULL,
    endpoint_id uuid NOT NULL,
    org_id uuid NOT NULL,
    provider text NOT NULL,
    label text,
    secret_ciphertext bytea NOT NULL,
    wrapped_dek bytea NOT NULL,
    kek_ref text NOT NULL,
    enc_nonce bytea NOT NULL,
    enc_context jsonb DEFAULT '{}'::jsonb NOT NULL,
    envelope_version smallint NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_secrets_status_check CHECK ((status = ANY (ARRAY['active'::text, 'retiring'::text, 'revoked'::text])))
);

ALTER TABLE ONLY public.provider_secrets FORCE ROW LEVEL SECURITY;


--
-- Name: replay_destinations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.replay_destinations (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    url text NOT NULL,
    label text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_validated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    ordered boolean DEFAULT false NOT NULL,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    disabled_at timestamp with time zone
);

ALTER TABLE ONLY public.replay_destinations FORCE ROW LEVEL SECURITY;


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session (
    id text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    token text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL
);


--
-- Name: signing_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.signing_keys (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    secret_ciphertext bytea NOT NULL,
    wrapped_dek bytea NOT NULL,
    kek_ref text NOT NULL,
    enc_nonce bytea NOT NULL,
    enc_context jsonb DEFAULT '{}'::jsonb NOT NULL,
    envelope_version smallint NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    destination_id uuid NOT NULL,
    CONSTRAINT signing_keys_status_check CHECK ((status = ANY (ARRAY['active'::text, 'retiring'::text, 'revoked'::text])))
);

ALTER TABLE ONLY public.signing_keys FORCE ROW LEVEL SECURITY;


--
-- Name: stripe_meter_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stripe_meter_reports (
    org_id uuid NOT NULL,
    day date NOT NULL,
    event_count bigint NOT NULL,
    identifier text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    stripe_meter_event_id text,
    attempts integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    CONSTRAINT stripe_meter_reports_check CHECK ((identifier = (((org_id)::text || ':'::text) || (day)::text))),
    CONSTRAINT stripe_meter_reports_event_count_check CHECK ((event_count >= 0)),
    CONSTRAINT stripe_meter_reports_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text])))
);

ALTER TABLE ONLY public.stripe_meter_reports FORCE ROW LEVEL SECURITY;


--
-- Name: usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage (
    org_id uuid NOT NULL,
    window_start timestamp with time zone NOT NULL,
    event_count bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    finalized_at timestamp with time zone,
    counts_deliveries boolean DEFAULT true NOT NULL,
    counts_only_billable boolean DEFAULT true NOT NULL
);

ALTER TABLE ONLY public.usage FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN usage.finalized_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.usage.finalized_at IS 'When set, this day''s event_count is frozen (an immutable billing snapshot): the rollup never recounts it, so a later events-retention prune cannot make a billed count decrease. NULL = still open/recounted.';


--
-- Name: usage_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_alerts (
    org_id uuid NOT NULL,
    period_start timestamp with time zone NOT NULL,
    threshold smallint NOT NULL,
    alerted_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.usage_alerts FORCE ROW LEVEL SECURITY;


--
-- Name: user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."user" (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    "emailVerified" boolean NOT NULL,
    image text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "firstName" text,
    "lastName" text,
    "onboardedAt" timestamp with time zone
);


--
-- Name: verification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log ALTER COLUMN id SET DEFAULT nextval('public.audit_log_id_seq'::regclass);


--
-- Name: auth_audit_event id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_audit_event ALTER COLUMN id SET DEFAULT nextval('public.auth_audit_event_id_seq'::regclass);


--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);


--
-- Name: agent_triggers agent_triggers_id_org_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_triggers
    ADD CONSTRAINT agent_triggers_id_org_id_key UNIQUE (id, org_id);


--
-- Name: agent_triggers agent_triggers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_triggers
    ADD CONSTRAINT agent_triggers_pkey PRIMARY KEY (id);


--
-- Name: api_keys api_keys_id_org_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_id_org_id_key UNIQUE (id, org_id);


--
-- Name: api_keys api_keys_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_key_hash_key UNIQUE (key_hash);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: apikey apikey_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apikey
    ADD CONSTRAINT apikey_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_org_id_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_org_id_seq_key UNIQUE (org_id, seq);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: auth_audit_event auth_audit_event_event_type_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.auth_audit_event
    ADD CONSTRAINT auth_audit_event_event_type_check CHECK ((event_type = ANY (ARRAY['login'::text, 'grant_created'::text, 'grant_approved'::text, 'grant_revoked'::text, 'key_minted'::text, 'key_revoked'::text, 'policy_changed'::text, 'reauth'::text, 'invite_created'::text, 'invite_accepted'::text, 'invite_revoked'::text, 'member_role_changed'::text, 'member_removed'::text, 'org_created'::text, 'org_renamed'::text]))) NOT VALID;


--
-- Name: auth_audit_event auth_audit_event_org_id_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_audit_event
    ADD CONSTRAINT auth_audit_event_org_id_seq_key UNIQUE (org_id, seq);


--
-- Name: auth_audit_event auth_audit_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_audit_event
    ADD CONSTRAINT auth_audit_event_pkey PRIMARY KEY (id);


--
-- Name: auth_grant auth_grant_id_org_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_grant
    ADD CONSTRAINT auth_grant_id_org_id_key UNIQUE (id, org_id);


--
-- Name: auth_grant auth_grant_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_grant
    ADD CONSTRAINT auth_grant_pkey PRIMARY KEY (id);


--
-- Name: auth_refresh_token auth_refresh_token_id_org_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_refresh_token
    ADD CONSTRAINT auth_refresh_token_id_org_id_key UNIQUE (id, org_id);


--
-- Name: auth_refresh_token auth_refresh_token_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_refresh_token
    ADD CONSTRAINT auth_refresh_token_pkey PRIMARY KEY (id);


--
-- Name: auth_refresh_token auth_refresh_token_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_refresh_token
    ADD CONSTRAINT auth_refresh_token_token_hash_key UNIQUE (token_hash);


--
-- Name: auth_session_exchange auth_session_exchange_id_org_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session_exchange
    ADD CONSTRAINT auth_session_exchange_id_org_id_key UNIQUE (id, org_id);


--
-- Name: auth_session_exchange auth_session_exchange_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session_exchange
    ADD CONSTRAINT auth_session_exchange_pkey PRIMARY KEY (id);


--
-- Name: auth_session_exchange auth_session_exchange_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session_exchange
    ADD CONSTRAINT auth_session_exchange_token_hash_key UNIQUE (token_hash);


--
-- Name: billing_customers billing_customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_customers
    ADD CONSTRAINT billing_customers_pkey PRIMARY KEY (org_id);


--
-- Name: billing_customers billing_customers_stripe_customer_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_customers
    ADD CONSTRAINT billing_customers_stripe_customer_id_key UNIQUE (stripe_customer_id);


--
-- Name: billing_subscriptions billing_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_subscriptions
    ADD CONSTRAINT billing_subscriptions_pkey PRIMARY KEY (org_id);


--
-- Name: billing_subscriptions billing_subscriptions_stripe_subscription_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_subscriptions
    ADD CONSTRAINT billing_subscriptions_stripe_subscription_id_key UNIQUE (stripe_subscription_id);


--
-- Name: delivery_attempts delivery_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_attempts
    ADD CONSTRAINT delivery_attempts_pkey PRIMARY KEY (id);


--
-- Name: delivery_stats delivery_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_stats
    ADD CONSTRAINT delivery_stats_pkey PRIMARY KEY (org_id, window_start);


--
-- Name: delivery_subscriptions delivery_subscriptions_id_org_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_subscriptions
    ADD CONSTRAINT delivery_subscriptions_id_org_id_key UNIQUE (id, org_id);


--
-- Name: delivery_subscriptions delivery_subscriptions_org_id_source_endpoint_id_destinatio_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_subscriptions
    ADD CONSTRAINT delivery_subscriptions_org_id_source_endpoint_id_destinatio_key UNIQUE (org_id, source_endpoint_id, destination_id);


--
-- Name: delivery_subscriptions delivery_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_subscriptions
    ADD CONSTRAINT delivery_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: endpoints endpoints_id_org_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.endpoints
    ADD CONSTRAINT endpoints_id_org_id_key UNIQUE (id, org_id);


--
-- Name: endpoints endpoints_ingest_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.endpoints
    ADD CONSTRAINT endpoints_ingest_token_hash_key UNIQUE (ingest_token_hash);


--
-- Name: endpoints endpoints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.endpoints
    ADD CONSTRAINT endpoints_pkey PRIMARY KEY (id);


--
-- Name: event_payload_purge event_payload_purge_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_payload_purge
    ADD CONSTRAINT event_payload_purge_pkey PRIMARY KEY (event_id);


--
-- Name: events events_endpoint_id_dedup_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_endpoint_id_dedup_key_key UNIQUE (endpoint_id, dedup_key);


--
-- Name: events events_id_org_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_id_org_id_key UNIQUE (id, org_id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: ingest_paused ingest_paused_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_paused
    ADD CONSTRAINT ingest_paused_pkey PRIMARY KEY (org_id);


--
-- Name: memberships memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (org_id, user_id);


--
-- Name: notification_intents notification_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_intents
    ADD CONSTRAINT notification_intents_pkey PRIMARY KEY (id);


--
-- Name: org_deletions org_deletions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_deletions
    ADD CONSTRAINT org_deletions_pkey PRIMARY KEY (org_id);


--
-- Name: org_invites org_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invites
    ADD CONSTRAINT org_invites_pkey PRIMARY KEY (id);


--
-- Name: org_limits org_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_limits
    ADD CONSTRAINT org_limits_pkey PRIMARY KEY (org_id);


--
-- Name: org_policy org_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_policy
    ADD CONSTRAINT org_policy_pkey PRIMARY KEY (org_id);


--
-- Name: org_slug_history org_slug_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_slug_history
    ADD CONSTRAINT org_slug_history_pkey PRIMARY KEY (slug);


--
-- Name: orgs orgs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orgs
    ADD CONSTRAINT orgs_pkey PRIMARY KEY (id);


--
-- Name: orgs orgs_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orgs
    ADD CONSTRAINT orgs_slug_key UNIQUE (slug);


--
-- Name: processed_stripe_events processed_stripe_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.processed_stripe_events
    ADD CONSTRAINT processed_stripe_events_pkey PRIMARY KEY (event_id);


--
-- Name: provider_secrets provider_secrets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_secrets
    ADD CONSTRAINT provider_secrets_pkey PRIMARY KEY (id);


--
-- Name: replay_destinations replay_destinations_id_org_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replay_destinations
    ADD CONSTRAINT replay_destinations_id_org_id_key UNIQUE (id, org_id);


--
-- Name: replay_destinations replay_destinations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replay_destinations
    ADD CONSTRAINT replay_destinations_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);


--
-- Name: session session_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_token_key UNIQUE (token);


--
-- Name: signing_keys signing_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signing_keys
    ADD CONSTRAINT signing_keys_pkey PRIMARY KEY (id);


--
-- Name: stripe_meter_reports stripe_meter_reports_identifier_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_meter_reports
    ADD CONSTRAINT stripe_meter_reports_identifier_key UNIQUE (identifier);


--
-- Name: stripe_meter_reports stripe_meter_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_meter_reports
    ADD CONSTRAINT stripe_meter_reports_pkey PRIMARY KEY (org_id, day);


--
-- Name: usage_alerts usage_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_alerts
    ADD CONSTRAINT usage_alerts_pkey PRIMARY KEY (org_id, period_start, threshold);


--
-- Name: usage usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage
    ADD CONSTRAINT usage_pkey PRIMARY KEY (org_id, window_start);


--
-- Name: user user_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_email_key UNIQUE (email);


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);


--
-- Name: verification verification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);


--
-- Name: account_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "account_userId_idx" ON public.account USING btree ("userId");


--
-- Name: agent_triggers_endpoint_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_triggers_endpoint_idx ON public.agent_triggers USING btree (org_id, endpoint_id) WHERE (revoked_at IS NULL);


--
-- Name: api_keys_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_keys_created_by_idx ON public.api_keys USING btree (org_id, created_by) WHERE (created_by IS NOT NULL);


--
-- Name: api_keys_grant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_keys_grant_idx ON public.api_keys USING btree (grant_id);


--
-- Name: api_keys_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_keys_org_idx ON public.api_keys USING btree (org_id, created_at DESC);


--
-- Name: apikey_configId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "apikey_configId_idx" ON public.apikey USING btree ("configId");


--
-- Name: apikey_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX apikey_key_idx ON public.apikey USING btree (key);


--
-- Name: apikey_referenceId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "apikey_referenceId_idx" ON public.apikey USING btree ("referenceId");


--
-- Name: audit_log_org_action_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_org_action_created_idx ON public.audit_log USING btree (org_id, action, created_at DESC);


--
-- Name: auth_audit_event_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_audit_event_org_created_idx ON public.auth_audit_event USING btree (org_id, created_at DESC);


--
-- Name: auth_audit_event_org_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_audit_event_org_type_idx ON public.auth_audit_event USING btree (org_id, event_type, created_at DESC);


--
-- Name: auth_grant_org_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_grant_org_status_idx ON public.auth_grant USING btree (org_id, status);


--
-- Name: auth_grant_user_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_grant_user_status_idx ON public.auth_grant USING btree (user_id, status);


--
-- Name: auth_refresh_token_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_refresh_token_expires_at_idx ON public.auth_refresh_token USING btree (expires_at);


--
-- Name: auth_refresh_token_grant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_refresh_token_grant_idx ON public.auth_refresh_token USING btree (grant_id);


--
-- Name: auth_session_exchange_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_session_exchange_expires_at_idx ON public.auth_session_exchange USING btree (expires_at);


--
-- Name: delivery_attempts_destination_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delivery_attempts_destination_idx ON public.delivery_attempts USING btree (destination_id);


--
-- Name: delivery_attempts_destination_ordered_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delivery_attempts_destination_ordered_idx ON public.delivery_attempts USING btree (destination_id, created_at, id);


--
-- Name: delivery_attempts_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delivery_attempts_due_idx ON public.delivery_attempts USING btree (destination_id, next_retry_at) WHERE (status = ANY (ARRAY['queued'::text, 'pending'::text]));


--
-- Name: delivery_attempts_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delivery_attempts_event_idx ON public.delivery_attempts USING btree (event_id);


--
-- Name: delivery_attempts_idempotency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX delivery_attempts_idempotency_idx ON public.delivery_attempts USING btree (org_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: delivery_attempts_ordered_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delivery_attempts_ordered_idx ON public.delivery_attempts USING btree (destination_id, created_at, id) WHERE (status = ANY (ARRAY['queued'::text, 'pending'::text]));


--
-- Name: delivery_attempts_org_ordered_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delivery_attempts_org_ordered_idx ON public.delivery_attempts USING btree (org_id, created_at, id);


--
-- Name: delivery_attempts_subscription_ordered_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delivery_attempts_subscription_ordered_idx ON public.delivery_attempts USING btree (subscription_id, created_at, id) WHERE (subscription_id IS NOT NULL);


--
-- Name: delivery_subscriptions_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delivery_subscriptions_source_idx ON public.delivery_subscriptions USING btree (org_id, source_endpoint_id) WHERE enabled;


--
-- Name: endpoints_org_ordered_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX endpoints_org_ordered_idx ON public.endpoints USING btree (org_id, created_at, id) WHERE (deleted_at IS NULL);


--
-- Name: event_payload_purge_purging_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_payload_purge_purging_idx ON public.event_payload_purge USING btree (requested_at) WHERE (status = 'purging'::text);


--
-- Name: events_dedup_key_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_dedup_key_trgm ON public.events USING gin (dedup_key public.gin_trgm_ops);


--
-- Name: events_external_id_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_external_id_trgm ON public.events USING gin (external_id public.gin_trgm_ops);


--
-- Name: events_failed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_failed_idx ON public.events USING btree (endpoint_id, received_at DESC) WHERE ((verification IS NOT NULL) AND (NOT verified));


--
-- Name: events_org_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_org_recent_idx ON public.events USING btree (org_id, received_at DESC);


--
-- Name: events_payload_r2_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_payload_r2_key_idx ON public.events USING btree (payload_r2_key);


--
-- Name: events_provider_event_id_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_provider_event_id_trgm ON public.events USING gin (provider_event_id public.gin_trgm_ops);


--
-- Name: events_provider_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_provider_idx ON public.events USING btree (endpoint_id, provider, received_at DESC);


--
-- Name: events_received_at_brin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_received_at_brin ON public.events USING brin (received_at);


--
-- Name: events_tunnel_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_tunnel_idx ON public.events USING btree (endpoint_id, received_at, id);


--
-- Name: memberships_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memberships_user_id_idx ON public.memberships USING btree (user_id);


--
-- Name: notification_intents_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_intents_pending_idx ON public.notification_intents USING btree (created_at) WHERE (status = 'pending'::text);


--
-- Name: org_deletions_purging_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX org_deletions_purging_idx ON public.org_deletions USING btree (requested_at) WHERE (status = 'purging'::text);


--
-- Name: org_invites_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX org_invites_email_idx ON public.org_invites USING btree (org_id, invited_email);


--
-- Name: org_invites_token_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX org_invites_token_hash_idx ON public.org_invites USING btree (token_hash);


--
-- Name: org_slug_history_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX org_slug_history_org_id_idx ON public.org_slug_history USING btree (org_id);


--
-- Name: provider_secrets_endpoint_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_secrets_endpoint_idx ON public.provider_secrets USING btree (endpoint_id, created_at DESC);


--
-- Name: replay_destinations_live_url_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX replay_destinations_live_url_idx ON public.replay_destinations USING btree (org_id, url) WHERE (deleted_at IS NULL);


--
-- Name: session_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "session_userId_idx" ON public.session USING btree ("userId");


--
-- Name: signing_keys_destination_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX signing_keys_destination_idx ON public.signing_keys USING btree (destination_id, org_id);


--
-- Name: stripe_meter_reports_unsent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stripe_meter_reports_unsent_idx ON public.stripe_meter_reports USING btree (org_id, day) WHERE (status <> 'sent'::text);


--
-- Name: verification_identifier_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX verification_identifier_idx ON public.verification USING btree (identifier);


--
-- Name: audit_log audit_log_chain_biu; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_log_chain_biu BEFORE INSERT ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.audit_log_chain();


--
-- Name: audit_log audit_log_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.audit_log_immutable();


--
-- Name: audit_log audit_log_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON public.audit_log FOR EACH STATEMENT EXECUTE FUNCTION public.audit_log_immutable();


--
-- Name: audit_log audit_log_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.audit_log_immutable();


--
-- Name: auth_audit_event auth_audit_event_chain_biu; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_audit_event_chain_biu BEFORE INSERT ON public.auth_audit_event FOR EACH ROW EXECUTE FUNCTION public.auth_audit_event_chain();


--
-- Name: auth_audit_event auth_audit_event_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_audit_event_no_delete BEFORE DELETE ON public.auth_audit_event FOR EACH ROW EXECUTE FUNCTION public.auth_audit_event_immutable();


--
-- Name: auth_audit_event auth_audit_event_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_audit_event_no_truncate BEFORE TRUNCATE ON public.auth_audit_event FOR EACH STATEMENT EXECUTE FUNCTION public.auth_audit_event_immutable();


--
-- Name: auth_audit_event auth_audit_event_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_audit_event_no_update BEFORE UPDATE ON public.auth_audit_event FOR EACH ROW EXECUTE FUNCTION public.auth_audit_event_immutable();


--
-- Name: delivery_attempts delivery_attempts_billable_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER delivery_attempts_billable_immutable BEFORE UPDATE ON public.delivery_attempts FOR EACH ROW EXECUTE FUNCTION public.guard_billable_immutable();


--
-- Name: delivery_subscriptions delivery_subscriptions_unlink_before_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER delivery_subscriptions_unlink_before_delete BEFORE DELETE ON public.delivery_subscriptions FOR EACH ROW EXECUTE FUNCTION public.unlink_subscription_deliveries();


--
-- Name: events events_received_at_biu; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER events_received_at_biu BEFORE INSERT ON public.events FOR EACH ROW EXECUTE FUNCTION public.events_stamp_received_at();


--
-- Name: orgs orgs_slug_not_retired_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orgs_slug_not_retired_trg BEFORE INSERT OR UPDATE OF slug ON public.orgs FOR EACH ROW EXECUTE FUNCTION public.orgs_slug_not_retired();


--
-- Name: orgs orgs_slug_record_history_on_delete_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orgs_slug_record_history_on_delete_trg BEFORE DELETE ON public.orgs FOR EACH ROW EXECUTE FUNCTION public.orgs_slug_record_history();


--
-- Name: orgs orgs_slug_record_history_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orgs_slug_record_history_trg AFTER UPDATE OF slug ON public.orgs FOR EACH ROW EXECUTE FUNCTION public.orgs_slug_record_history();


--
-- Name: usage usage_finalized_immutable_bu; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER usage_finalized_immutable_bu BEFORE UPDATE ON public.usage FOR EACH ROW EXECUTE FUNCTION public.usage_finalized_immutable();


--
-- Name: account account_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: agent_triggers agent_triggers_endpoint_id_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_triggers
    ADD CONSTRAINT agent_triggers_endpoint_id_org_id_fkey FOREIGN KEY (endpoint_id, org_id) REFERENCES public.endpoints(id, org_id) ON DELETE CASCADE;


--
-- Name: agent_triggers agent_triggers_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_triggers
    ADD CONSTRAINT agent_triggers_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: api_keys api_keys_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_created_by_fkey FOREIGN KEY (created_by) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: api_keys api_keys_grant_org_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_grant_org_fkey FOREIGN KEY (grant_id, org_id) REFERENCES public.auth_grant(id, org_id) ON DELETE CASCADE;


--
-- Name: api_keys api_keys_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: auth_grant auth_grant_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_grant
    ADD CONSTRAINT auth_grant_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: auth_grant auth_grant_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_grant
    ADD CONSTRAINT auth_grant_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: auth_grant auth_grant_revoked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_grant
    ADD CONSTRAINT auth_grant_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: auth_grant auth_grant_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_grant
    ADD CONSTRAINT auth_grant_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: auth_refresh_token auth_refresh_token_grant_org_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_refresh_token
    ADD CONSTRAINT auth_refresh_token_grant_org_fkey FOREIGN KEY (grant_id, org_id) REFERENCES public.auth_grant(id, org_id) ON DELETE CASCADE;


--
-- Name: auth_refresh_token auth_refresh_token_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_refresh_token
    ADD CONSTRAINT auth_refresh_token_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: auth_session_exchange auth_session_exchange_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session_exchange
    ADD CONSTRAINT auth_session_exchange_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: billing_customers billing_customers_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_customers
    ADD CONSTRAINT billing_customers_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: billing_subscriptions billing_subscriptions_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_subscriptions
    ADD CONSTRAINT billing_subscriptions_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: delivery_attempts delivery_attempts_destination_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_attempts
    ADD CONSTRAINT delivery_attempts_destination_fk FOREIGN KEY (destination_id, org_id) REFERENCES public.replay_destinations(id, org_id);


--
-- Name: delivery_attempts delivery_attempts_event_id_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_attempts
    ADD CONSTRAINT delivery_attempts_event_id_org_id_fkey FOREIGN KEY (event_id, org_id) REFERENCES public.events(id, org_id) ON DELETE CASCADE;


--
-- Name: delivery_attempts delivery_attempts_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_attempts
    ADD CONSTRAINT delivery_attempts_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: delivery_attempts delivery_attempts_subscription_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_attempts
    ADD CONSTRAINT delivery_attempts_subscription_fk FOREIGN KEY (subscription_id, org_id) REFERENCES public.delivery_subscriptions(id, org_id);


--
-- Name: delivery_stats delivery_stats_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_stats
    ADD CONSTRAINT delivery_stats_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: delivery_subscriptions delivery_subscriptions_destination_id_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_subscriptions
    ADD CONSTRAINT delivery_subscriptions_destination_id_org_id_fkey FOREIGN KEY (destination_id, org_id) REFERENCES public.replay_destinations(id, org_id) ON DELETE CASCADE;


--
-- Name: delivery_subscriptions delivery_subscriptions_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_subscriptions
    ADD CONSTRAINT delivery_subscriptions_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: delivery_subscriptions delivery_subscriptions_source_endpoint_id_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_subscriptions
    ADD CONSTRAINT delivery_subscriptions_source_endpoint_id_org_id_fkey FOREIGN KEY (source_endpoint_id, org_id) REFERENCES public.endpoints(id, org_id) ON DELETE CASCADE;


--
-- Name: endpoints endpoints_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.endpoints
    ADD CONSTRAINT endpoints_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: events events_endpoint_id_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_endpoint_id_org_id_fkey FOREIGN KEY (endpoint_id, org_id) REFERENCES public.endpoints(id, org_id) ON DELETE CASCADE;


--
-- Name: events events_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: ingest_paused ingest_paused_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_paused
    ADD CONSTRAINT ingest_paused_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: memberships memberships_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: memberships memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: notification_intents notification_intents_destination_id_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_intents
    ADD CONSTRAINT notification_intents_destination_id_org_id_fkey FOREIGN KEY (destination_id, org_id) REFERENCES public.replay_destinations(id, org_id) ON DELETE CASCADE;


--
-- Name: notification_intents notification_intents_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_intents
    ADD CONSTRAINT notification_intents_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: org_invites org_invites_accepted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invites
    ADD CONSTRAINT org_invites_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: org_invites org_invites_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invites
    ADD CONSTRAINT org_invites_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public."user"(id) ON DELETE SET NULL;


--
-- Name: org_invites org_invites_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invites
    ADD CONSTRAINT org_invites_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: org_limits org_limits_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_limits
    ADD CONSTRAINT org_limits_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: org_policy org_policy_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_policy
    ADD CONSTRAINT org_policy_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: org_slug_history org_slug_history_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_slug_history
    ADD CONSTRAINT org_slug_history_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE SET NULL;


--
-- Name: provider_secrets provider_secrets_endpoint_id_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_secrets
    ADD CONSTRAINT provider_secrets_endpoint_id_org_id_fkey FOREIGN KEY (endpoint_id, org_id) REFERENCES public.endpoints(id, org_id) ON DELETE CASCADE;


--
-- Name: provider_secrets provider_secrets_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_secrets
    ADD CONSTRAINT provider_secrets_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: replay_destinations replay_destinations_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replay_destinations
    ADD CONSTRAINT replay_destinations_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: session session_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: signing_keys signing_keys_destination_id_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signing_keys
    ADD CONSTRAINT signing_keys_destination_id_org_id_fkey FOREIGN KEY (destination_id, org_id) REFERENCES public.replay_destinations(id, org_id) ON DELETE CASCADE;


--
-- Name: signing_keys signing_keys_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signing_keys
    ADD CONSTRAINT signing_keys_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: stripe_meter_reports stripe_meter_reports_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_meter_reports
    ADD CONSTRAINT stripe_meter_reports_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: usage_alerts usage_alerts_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_alerts
    ADD CONSTRAINT usage_alerts_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: usage usage_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage
    ADD CONSTRAINT usage_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: agent_triggers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_triggers ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_triggers agent_triggers_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY agent_triggers_delete ON public.agent_triggers FOR DELETE USING ((org_id = public.current_org_id()));


--
-- Name: agent_triggers agent_triggers_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY agent_triggers_insert ON public.agent_triggers FOR INSERT WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: agent_triggers agent_triggers_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY agent_triggers_select ON public.agent_triggers FOR SELECT USING ((org_id = public.current_org_id()));


--
-- Name: agent_triggers agent_triggers_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY agent_triggers_update ON public.agent_triggers FOR UPDATE USING ((org_id = public.current_org_id())) WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: api_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: api_keys api_keys_authn_last_used; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY api_keys_authn_last_used ON public.api_keys FOR UPDATE TO webhook_authn USING (true) WITH CHECK (true);


--
-- Name: api_keys api_keys_authn_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY api_keys_authn_select ON public.api_keys FOR SELECT TO webhook_authn USING (true);


--
-- Name: api_keys api_keys_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY api_keys_delete ON public.api_keys FOR DELETE USING ((org_id = public.current_org_id()));


--
-- Name: api_keys api_keys_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY api_keys_insert ON public.api_keys FOR INSERT WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: api_keys api_keys_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY api_keys_select ON public.api_keys FOR SELECT USING ((org_id = public.current_org_id()));


--
-- Name: api_keys api_keys_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY api_keys_update ON public.api_keys FOR UPDATE USING ((org_id = public.current_org_id())) WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_log audit_log_anchor_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audit_log_anchor_select ON public.audit_log FOR SELECT TO webhook_anchor USING (true);


--
-- Name: audit_log audit_log_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audit_log_insert ON public.audit_log FOR INSERT WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: audit_log audit_log_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audit_log_select ON public.audit_log FOR SELECT USING ((org_id = public.current_org_id()));


--
-- Name: auth_audit_event; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.auth_audit_event ENABLE ROW LEVEL SECURITY;

--
-- Name: auth_audit_event auth_audit_event_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_audit_event_insert ON public.auth_audit_event FOR INSERT WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: auth_audit_event auth_audit_event_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_audit_event_select ON public.auth_audit_event FOR SELECT USING ((org_id = public.current_org_id()));


--
-- Name: auth_grant; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.auth_grant ENABLE ROW LEVEL SECURITY;

--
-- Name: auth_grant auth_grant_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_grant_delete ON public.auth_grant FOR DELETE USING ((org_id = public.current_org_id()));


--
-- Name: auth_grant auth_grant_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_grant_insert ON public.auth_grant FOR INSERT WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: auth_grant auth_grant_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_grant_select ON public.auth_grant FOR SELECT USING ((org_id = public.current_org_id()));


--
-- Name: auth_grant auth_grant_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_grant_update ON public.auth_grant FOR UPDATE USING ((org_id = public.current_org_id())) WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: auth_refresh_token; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.auth_refresh_token ENABLE ROW LEVEL SECURITY;

--
-- Name: auth_refresh_token auth_refresh_token_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_refresh_token_delete ON public.auth_refresh_token FOR DELETE USING ((org_id = public.current_org_id()));


--
-- Name: auth_refresh_token auth_refresh_token_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_refresh_token_insert ON public.auth_refresh_token FOR INSERT WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: auth_refresh_token auth_refresh_token_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_refresh_token_select ON public.auth_refresh_token FOR SELECT USING ((org_id = public.current_org_id()));


--
-- Name: auth_refresh_token auth_refresh_token_sweeper_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_refresh_token_sweeper_delete ON public.auth_refresh_token FOR DELETE TO webhook_sweeper USING ((expires_at < now()));


--
-- Name: auth_refresh_token auth_refresh_token_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_refresh_token_update ON public.auth_refresh_token FOR UPDATE USING ((org_id = public.current_org_id())) WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: auth_session_exchange; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.auth_session_exchange ENABLE ROW LEVEL SECURITY;

--
-- Name: auth_session_exchange auth_session_exchange_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_session_exchange_delete ON public.auth_session_exchange FOR DELETE USING ((org_id = public.current_org_id()));


--
-- Name: auth_session_exchange auth_session_exchange_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_session_exchange_insert ON public.auth_session_exchange FOR INSERT WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: auth_session_exchange auth_session_exchange_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_session_exchange_select ON public.auth_session_exchange FOR SELECT USING ((org_id = public.current_org_id()));


--
-- Name: auth_session_exchange auth_session_exchange_sweeper_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_session_exchange_sweeper_delete ON public.auth_session_exchange FOR DELETE TO webhook_sweeper USING ((expires_at < now()));


--
-- Name: auth_session_exchange auth_session_exchange_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_session_exchange_update ON public.auth_session_exchange FOR UPDATE USING ((org_id = public.current_org_id())) WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: billing_customers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.billing_customers ENABLE ROW LEVEL SECURITY;

--
-- Name: billing_customers billing_customers_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_customers_select ON public.billing_customers FOR SELECT USING ((org_id = public.current_org_id()));


--
-- Name: billing_customers billing_customers_transport_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_customers_transport_select ON public.billing_customers FOR SELECT TO webhook_meter_transport USING (true);


--
-- Name: billing_customers billing_customers_write_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_customers_write_insert ON public.billing_customers FOR INSERT WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: billing_customers billing_customers_write_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_customers_write_update ON public.billing_customers FOR UPDATE USING ((org_id = public.current_org_id())) WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: billing_subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.billing_subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: billing_subscriptions billing_subscriptions_meter_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_subscriptions_meter_select ON public.billing_subscriptions FOR SELECT TO webhook_meter USING (true);


--
-- Name: billing_subscriptions billing_subscriptions_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_subscriptions_select ON public.billing_subscriptions FOR SELECT USING ((org_id = public.current_org_id()));


--
-- Name: billing_subscriptions billing_subscriptions_write_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_subscriptions_write_insert ON public.billing_subscriptions FOR INSERT WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: billing_subscriptions billing_subscriptions_write_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY billing_subscriptions_write_update ON public.billing_subscriptions FOR UPDATE USING ((org_id = public.current_org_id())) WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: delivery_attempts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delivery_attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: delivery_attempts delivery_attempts_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delivery_attempts_delete ON public.delivery_attempts FOR DELETE USING ((org_id = public.current_org_id()));


--
-- Name: delivery_attempts delivery_attempts_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delivery_attempts_insert ON public.delivery_attempts FOR INSERT WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: delivery_attempts delivery_attempts_meter_audit_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delivery_attempts_meter_audit_select ON public.delivery_attempts FOR SELECT TO webhook_meter_audit USING (true);


--
-- Name: delivery_attempts delivery_attempts_meter_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delivery_attempts_meter_select ON public.delivery_attempts FOR SELECT TO webhook_meter USING (true);


--
-- Name: delivery_attempts delivery_attempts_reconciler_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delivery_attempts_reconciler_select ON public.delivery_attempts FOR SELECT TO webhook_reconciler USING (true);


--
-- Name: delivery_attempts delivery_attempts_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delivery_attempts_select ON public.delivery_attempts FOR SELECT USING ((org_id = public.current_org_id()));


--
-- Name: delivery_attempts delivery_attempts_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delivery_attempts_update ON public.delivery_attempts FOR UPDATE USING ((org_id = public.current_org_id())) WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: delivery_stats; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delivery_stats ENABLE ROW LEVEL SECURITY;

--
-- Name: delivery_stats delivery_stats_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delivery_stats_delete ON public.delivery_stats FOR DELETE USING ((org_id = public.current_org_id()));


--
-- Name: delivery_stats delivery_stats_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delivery_stats_insert ON public.delivery_stats FOR INSERT WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: delivery_stats delivery_stats_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delivery_stats_select ON public.delivery_stats FOR SELECT USING ((org_id = public.current_org_id()));


--
-- Name: delivery_stats delivery_stats_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delivery_stats_update ON public.delivery_stats FOR UPDATE USING ((org_id = public.current_org_id())) WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: delivery_subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delivery_subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: delivery_subscriptions delivery_subscriptions_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delivery_subscriptions_delete ON public.delivery_subscriptions FOR DELETE USING ((org_id = public.current_org_id()));


--
-- Name: delivery_subscriptions delivery_subscriptions_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delivery_subscriptions_insert ON public.delivery_subscriptions FOR INSERT WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: delivery_subscriptions delivery_subscriptions_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delivery_subscriptions_select ON public.delivery_subscriptions FOR SELECT USING ((org_id = public.current_org_id()));


--
-- Name: delivery_subscriptions delivery_subscriptions_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY delivery_subscriptions_update ON public.delivery_subscriptions FOR UPDATE USING ((org_id = public.current_org_id())) WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: endpoints; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.endpoints ENABLE ROW LEVEL SECURITY;

--
-- Name: endpoints endpoints_authn_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY endpoints_authn_select ON public.endpoints FOR SELECT TO webhook_authn USING (true);


--
-- Name: endpoints endpoints_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY endpoints_delete ON public.endpoints FOR DELETE USING ((org_id = public.current_org_id()));


--
-- Name: endpoints endpoints_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY endpoints_insert ON public.endpoints FOR INSERT WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: endpoints endpoints_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY endpoints_select ON public.endpoints FOR SELECT USING ((org_id = public.current_org_id()));


--
-- Name: endpoints endpoints_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY endpoints_update ON public.endpoints FOR UPDATE USING ((org_id = public.current_org_id())) WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: event_payload_purge; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.event_payload_purge ENABLE ROW LEVEL SECURITY;

--
-- Name: event_payload_purge event_payload_purge_app_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY event_payload_purge_app_insert ON public.event_payload_purge FOR INSERT TO webhook_app WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: event_payload_purge event_payload_purge_app_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY event_payload_purge_app_select ON public.event_payload_purge FOR SELECT TO webhook_app USING ((org_id = public.current_org_id()));


--
-- Name: event_payload_purge event_payload_purge_purge_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY event_payload_purge_purge_select ON public.event_payload_purge FOR SELECT TO webhook_purge USING (true);


--
-- Name: event_payload_purge event_payload_purge_purge_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY event_payload_purge_purge_update ON public.event_payload_purge FOR UPDATE TO webhook_purge USING ((status = 'purging'::text)) WITH CHECK ((status = ANY (ARRAY['purging'::text, 'completed'::text])));


--
-- Name: events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

--
-- Name: events events_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY events_delete ON public.events FOR DELETE USING ((org_id = public.current_org_id()));


--
-- Name: events events_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY events_insert ON public.events FOR INSERT WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: events events_meter_audit_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY events_meter_audit_select ON public.events FOR SELECT TO webhook_meter_audit USING (true);


--
-- Name: events events_meter_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY events_meter_select ON public.events FOR SELECT TO webhook_meter USING (true);


--
-- Name: events events_retention_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY events_retention_delete ON public.events FOR DELETE TO webhook_retention USING ((received_at < (now() - ((( SELECT o.retention_days
   FROM public.orgs o
  WHERE (o.id = events.org_id)))::double precision * '1 day'::interval))));


--
-- Name: events events_retention_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY events_retention_select ON public.events FOR SELECT TO webhook_retention USING (true);


--
-- Name: events events_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY events_select ON public.events FOR SELECT USING ((org_id = public.current_org_id()));


--
-- Name: events events_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY events_update ON public.events FOR UPDATE USING ((org_id = public.current_org_id())) WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: ingest_paused; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ingest_paused ENABLE ROW LEVEL SECURITY;

--
-- Name: ingest_paused ingest_paused_authn_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ingest_paused_authn_select ON public.ingest_paused FOR SELECT TO webhook_authn USING (true);


--
-- Name: ingest_paused ingest_paused_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ingest_paused_delete ON public.ingest_paused FOR DELETE USING ((org_id = public.current_org_id()));


--
-- Name: ingest_paused ingest_paused_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ingest_paused_insert ON public.ingest_paused FOR INSERT WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: ingest_paused ingest_paused_meter_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ingest_paused_meter_select ON public.ingest_paused FOR SELECT TO webhook_meter USING (true);


--
-- Name: ingest_paused ingest_paused_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ingest_paused_select ON public.ingest_paused FOR SELECT USING ((org_id = public.current_org_id()));


--
-- Name: ingest_paused ingest_paused_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ingest_paused_update ON public.ingest_paused FOR UPDATE USING ((org_id = public.current_org_id())) WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: memberships; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;

--
-- Name: memberships memberships_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY memberships_delete ON public.memberships FOR DELETE USING ((org_id = public.current_org_id()));


--
-- Name: memberships memberships_directory_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY memberships_directory_select ON public.memberships FOR SELECT TO webhook_owner USING ((user_id = public.current_app_user()));


--
-- Name: memberships memberships_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY memberships_insert ON public.memberships FOR INSERT WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: memberships memberships_notifier_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY memberships_notifier_select ON public.memberships FOR SELECT TO webhook_notifier USING (true);


--
-- Name: memberships memberships_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY memberships_select ON public.memberships FOR SELECT USING ((org_id = public.current_org_id()));


--
-- Name: memberships memberships_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY memberships_update ON public.memberships FOR UPDATE USING ((org_id = public.current_org_id())) WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: notification_intents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_intents ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_intents notification_intents_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notification_intents_delete ON public.notification_intents FOR DELETE USING ((org_id = public.current_org_id()));


--
-- Name: notification_intents notification_intents_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notification_intents_insert ON public.notification_intents FOR INSERT WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: notification_intents notification_intents_notifier_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notification_intents_notifier_select ON public.notification_intents FOR SELECT TO webhook_notifier USING (true);


--
-- Name: notification_intents notification_intents_notifier_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notification_intents_notifier_update ON public.notification_intents FOR UPDATE TO webhook_notifier USING ((status = 'pending'::text)) WITH CHECK ((status = 'sent'::text));


--
-- Name: notification_intents notification_intents_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notification_intents_select ON public.notification_intents FOR SELECT USING ((org_id = public.current_org_id()));


--
-- Name: notification_intents notification_intents_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notification_intents_update ON public.notification_intents FOR UPDATE USING ((org_id = public.current_org_id())) WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: org_deletions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.org_deletions ENABLE ROW LEVEL SECURITY;

--
-- Name: org_deletions org_deletions_app_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_deletions_app_insert ON public.org_deletions FOR INSERT TO webhook_app WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: org_deletions org_deletions_app_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_deletions_app_select ON public.org_deletions FOR SELECT TO webhook_app USING ((org_id = public.current_org_id()));


--
-- Name: org_deletions org_deletions_purge_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_deletions_purge_select ON public.org_deletions FOR SELECT TO webhook_purge USING (true);


--
-- Name: org_deletions org_deletions_purge_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_deletions_purge_update ON public.org_deletions FOR UPDATE TO webhook_purge USING ((status = 'purging'::text)) WITH CHECK ((status = ANY (ARRAY['purging'::text, 'completed'::text])));


--
-- Name: org_invites; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.org_invites ENABLE ROW LEVEL SECURITY;

--
-- Name: org_invites org_invites_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_invites_delete ON public.org_invites FOR DELETE USING ((org_id = public.current_org_id()));


--
-- Name: org_invites org_invites_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_invites_insert ON public.org_invites FOR INSERT WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: org_invites org_invites_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_invites_select ON public.org_invites FOR SELECT USING ((org_id = public.current_org_id()));


--
-- Name: org_invites org_invites_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_invites_update ON public.org_invites FOR UPDATE USING ((org_id = public.current_org_id())) WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: org_limits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.org_limits ENABLE ROW LEVEL SECURITY;

--
-- Name: org_limits org_limits_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_limits_delete ON public.org_limits FOR DELETE USING ((org_id = public.current_org_id()));


--
-- Name: org_limits org_limits_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_limits_insert ON public.org_limits FOR INSERT WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: org_limits org_limits_meter_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_limits_meter_select ON public.org_limits FOR SELECT TO webhook_meter USING (true);


--
-- Name: org_limits org_limits_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_limits_select ON public.org_limits FOR SELECT USING ((org_id = public.current_org_id()));


--
-- Name: org_limits org_limits_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_limits_update ON public.org_limits FOR UPDATE USING ((org_id = public.current_org_id())) WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: org_policy; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.org_policy ENABLE ROW LEVEL SECURITY;

--
-- Name: org_policy org_policy_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_policy_delete ON public.org_policy FOR DELETE USING ((org_id = public.current_org_id()));


--
-- Name: org_policy org_policy_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_policy_insert ON public.org_policy FOR INSERT WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: org_policy org_policy_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_policy_select ON public.org_policy FOR SELECT USING ((org_id = public.current_org_id()));


--
-- Name: org_policy org_policy_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_policy_update ON public.org_policy FOR UPDATE USING ((org_id = public.current_org_id())) WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: org_slug_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.org_slug_history ENABLE ROW LEVEL SECURITY;

--
-- Name: org_slug_history org_slug_history_definer; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_slug_history_definer ON public.org_slug_history TO webhook_owner USING (true) WITH CHECK (true);


--
-- Name: org_slug_history org_slug_history_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_slug_history_tenant ON public.org_slug_history FOR SELECT TO webhook_app USING ((org_id = public.current_org_id()));


--
-- Name: orgs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.orgs ENABLE ROW LEVEL SECURITY;

--
-- Name: orgs orgs_billing_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY orgs_billing_update ON public.orgs FOR UPDATE TO webhook_billing USING ((id = public.current_org_id())) WITH CHECK ((id = public.current_org_id()));


--
-- Name: orgs orgs_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY orgs_delete ON public.orgs FOR DELETE USING ((id = public.current_org_id()));


--
-- Name: orgs orgs_directory_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY orgs_directory_select ON public.orgs FOR SELECT TO webhook_owner USING ((EXISTS ( SELECT 1
   FROM public.memberships m
  WHERE ((m.org_id = orgs.id) AND (m.user_id = public.current_app_user())))));


--
-- Name: orgs orgs_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY orgs_insert ON public.orgs FOR INSERT WITH CHECK ((id = public.current_org_id()));


--
-- Name: orgs orgs_retention_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY orgs_retention_select ON public.orgs FOR SELECT TO webhook_retention USING (true);


--
-- Name: orgs orgs_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY orgs_select ON public.orgs FOR SELECT USING ((id = public.current_org_id()));


--
-- Name: orgs orgs_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY orgs_update ON public.orgs FOR UPDATE USING ((id = public.current_org_id())) WITH CHECK ((id = public.current_org_id()));


--
-- Name: provider_secrets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.provider_secrets ENABLE ROW LEVEL SECURITY;

--
-- Name: provider_secrets provider_secrets_authn_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY provider_secrets_authn_select ON public.provider_secrets FOR SELECT TO webhook_authn USING (true);


--
-- Name: provider_secrets provider_secrets_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY provider_secrets_delete ON public.provider_secrets FOR DELETE USING ((org_id = public.current_org_id()));


--
-- Name: provider_secrets provider_secrets_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY provider_secrets_insert ON public.provider_secrets FOR INSERT WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: provider_secrets provider_secrets_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY provider_secrets_select ON public.provider_secrets FOR SELECT USING ((org_id = public.current_org_id()));


--
-- Name: provider_secrets provider_secrets_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY provider_secrets_update ON public.provider_secrets FOR UPDATE USING ((org_id = public.current_org_id())) WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: replay_destinations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.replay_destinations ENABLE ROW LEVEL SECURITY;

--
-- Name: replay_destinations replay_destinations_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY replay_destinations_delete ON public.replay_destinations FOR DELETE USING ((org_id = public.current_org_id()));


--
-- Name: replay_destinations replay_destinations_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY replay_destinations_insert ON public.replay_destinations FOR INSERT WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: replay_destinations replay_destinations_reconciler_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY replay_destinations_reconciler_select ON public.replay_destinations FOR SELECT TO webhook_reconciler USING (true);


--
-- Name: replay_destinations replay_destinations_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY replay_destinations_select ON public.replay_destinations FOR SELECT USING ((org_id = public.current_org_id()));


--
-- Name: replay_destinations replay_destinations_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY replay_destinations_update ON public.replay_destinations FOR UPDATE USING ((org_id = public.current_org_id())) WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: signing_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.signing_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: signing_keys signing_keys_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY signing_keys_delete ON public.signing_keys FOR DELETE USING ((org_id = public.current_org_id()));


--
-- Name: signing_keys signing_keys_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY signing_keys_insert ON public.signing_keys FOR INSERT WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: signing_keys signing_keys_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY signing_keys_select ON public.signing_keys FOR SELECT USING ((org_id = public.current_org_id()));


--
-- Name: signing_keys signing_keys_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY signing_keys_update ON public.signing_keys FOR UPDATE USING ((org_id = public.current_org_id())) WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: stripe_meter_reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stripe_meter_reports ENABLE ROW LEVEL SECURITY;

--
-- Name: stripe_meter_reports stripe_meter_reports_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stripe_meter_reports_insert ON public.stripe_meter_reports FOR INSERT WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: stripe_meter_reports stripe_meter_reports_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stripe_meter_reports_select ON public.stripe_meter_reports FOR SELECT USING ((org_id = public.current_org_id()));


--
-- Name: stripe_meter_reports stripe_meter_reports_transport_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stripe_meter_reports_transport_select ON public.stripe_meter_reports FOR SELECT TO webhook_meter_transport USING (true);


--
-- Name: stripe_meter_reports stripe_meter_reports_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stripe_meter_reports_update ON public.stripe_meter_reports FOR UPDATE USING ((org_id = public.current_org_id())) WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.usage ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_alerts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.usage_alerts ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_alerts usage_alerts_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY usage_alerts_insert ON public.usage_alerts FOR INSERT WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: usage_alerts usage_alerts_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY usage_alerts_select ON public.usage_alerts FOR SELECT USING ((org_id = public.current_org_id()));


--
-- Name: usage usage_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY usage_delete ON public.usage FOR DELETE USING ((org_id = public.current_org_id()));


--
-- Name: usage usage_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY usage_insert ON public.usage FOR INSERT WITH CHECK ((org_id = public.current_org_id()));


--
-- Name: usage usage_meter_audit_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY usage_meter_audit_select ON public.usage FOR SELECT TO webhook_meter_audit USING (true);


--
-- Name: usage usage_meter_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY usage_meter_select ON public.usage FOR SELECT TO webhook_meter USING (true);


--
-- Name: usage usage_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY usage_select ON public.usage FOR SELECT USING ((org_id = public.current_org_id()));


--
-- Name: usage usage_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY usage_update ON public.usage FOR UPDATE USING ((org_id = public.current_org_id())) WITH CHECK ((org_id = public.current_org_id()));


--
-- PostgreSQL database dump complete
--

\unrestrict ybotiBi0vIcmtJfFPUvQnT1UdXKJ6IJL3HkXK5GhZMLzvUINEGH3s2ZtqwcNHRp


--
-- Dbmate schema migrations
--

INSERT INTO public.schema_migrations (version) VALUES
    ('0001'),
    ('0002'),
    ('0003'),
    ('0004'),
    ('0005'),
    ('0006'),
    ('0007'),
    ('0008'),
    ('0009'),
    ('0010'),
    ('0011'),
    ('0012'),
    ('0013'),
    ('0014'),
    ('0015'),
    ('0016'),
    ('0017'),
    ('0018'),
    ('0019'),
    ('0020'),
    ('0021'),
    ('0022'),
    ('0023'),
    ('0024'),
    ('0025'),
    ('0026'),
    ('0027'),
    ('0028'),
    ('0029'),
    ('0030'),
    ('0031'),
    ('0032'),
    ('0033'),
    ('0034'),
    ('0035'),
    ('0036'),
    ('0037'),
    ('0038'),
    ('0039'),
    ('0040'),
    ('0041'),
    ('0042'),
    ('0043'),
    ('0044'),
    ('0045'),
    ('0046'),
    ('0047'),
    ('0048'),
    ('0049'),
    ('0050'),
    ('0051'),
    ('0052'),
    ('0053'),
    ('0054'),
    ('0055'),
    ('0056'),
    ('0057'),
    ('0058'),
    ('0059'),
    ('0060'),
    ('0061'),
    ('0062'),
    ('0063'),
    ('0064'),
    ('0065'),
    ('0066'),
    ('0067'),
    ('0068'),
    ('0069'),
    ('0070'),
    ('0071'),
    ('0072'),
    ('0073');
