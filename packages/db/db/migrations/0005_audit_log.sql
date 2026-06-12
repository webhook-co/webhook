-- migrate:up

-- Tamper-evident, append-only, per-org hash-chained audit log (H2, plan §0.7).
-- CONTROL-PLANE events only (endpoint created, key rotated, replay triggered, …) —
-- never per-event capture (that stays in events / delivery_attempts).
--
-- Division of responsibility:
--   * The DB enforces the chain STRUCTURE: contiguous per-org seq, prev_hash linked
--     to the prior row_hash, server-stamped created_at, and immutability (no
--     UPDATE/DELETE/TRUNCATE).
--   * The APP supplies row_hash = HMAC(key, prev_hash || canonical(fields)) with the
--     key held OUTSIDE the DB role (so a DB compromise can't forge a chain) and the
--     canonical serialization frozen in packages/shared. The WORM head-anchor cron
--     is post-freeze; the fields it anchors are frozen here.
--   * actor is the pseudonymous Better Auth user_id (M1) — text, NOT a FK, so user
--     erasure never deletes audit history; never raw PII.

create table audit_log (
  id bigserial primary key,
  org_id uuid not null references orgs (id) on delete cascade,
  seq bigint not null,
  actor text,
  action text not null,
  target text,
  prev_hash bytea,
  row_hash bytea not null,
  created_at timestamptz not null default now(),
  unique (org_id, seq)
);

-- Chain-integrity enforcement on insert. INVOKER (default): its lookup runs under
-- the caller's RLS, and the insert policy already requires app.current_org = org_id,
-- so the prior-row lookup sees exactly this org's chain. The unique (org_id, seq) is
-- the serialization point under concurrency — a racing append hits a duplicate-seq
-- error and retries.
create function audit_log_chain() returns trigger
  language plpgsql
  as $$
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
create trigger audit_log_chain_biu before insert on audit_log
  for each row execute function audit_log_chain();

-- Immutability: reject UPDATE/DELETE (row-level) and TRUNCATE (statement-level).
-- Append-only grants alone aren't enough — the owner could otherwise edit history,
-- which would void the tamper-evidence claim.
create function audit_log_immutable() returns trigger
  language plpgsql
  as $$
begin
  raise exception 'audit_log is append-only: % is not permitted', tg_op
    using errcode = 'check_violation';
end
$$;
create trigger audit_log_no_update before update on audit_log
  for each row execute function audit_log_immutable();
create trigger audit_log_no_delete before delete on audit_log
  for each row execute function audit_log_immutable();
create trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function audit_log_immutable();

alter table audit_log enable row level security;
alter table audit_log force row level security;
-- Only SELECT + INSERT policies exist; UPDATE/DELETE are deny-by-default (no policy)
-- on top of the trigger and the withheld privileges.
create policy audit_log_select on audit_log for select using (org_id = current_org_id());
create policy audit_log_insert on audit_log for insert with check (org_id = current_org_id());
-- INSERT + SELECT only (read needed to compute prev_hash and for verification/export).
grant select, insert on audit_log to webhook_app;
grant usage, select on sequence audit_log_id_seq to webhook_app;

-- migrate:down

drop table if exists audit_log;
drop function if exists audit_log_immutable();
drop function if exists audit_log_chain();
