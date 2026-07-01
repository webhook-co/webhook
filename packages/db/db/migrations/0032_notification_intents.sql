-- migrate:up

-- notification_intents (S3 Slice 3 PR3c): a durable "someone should be emailed about this" queue. The
-- engine DO can't send mail (it has no identity-email read — `user` is webhook_auth, not webhook_app — and
-- no Resend binding), so when a destination auto-disables the DO writes an INTENT here IN THE SAME tx as the
-- disable; a separate notifier WITH the identity-email read + a RESEND_API_KEY (PR3c-3) drains pending intents
-- → emails the org owner → marks them sent. The engine never sends mail directly (the role boundary).
--
-- Standard tenant-table shape (migration 0003 / 0024 / 0029): org_id + RLS ENABLED + FORCE + per-command
-- policies on current_org_id() (deny-by-default), DML granted to webhook_app (the DO inserts under the org's
-- RLS). Ids are edge-generated UUIDs (no DB default). The composite FK keeps the destination reference
-- same-org (defense-in-depth on RLS); replay_destinations is soft-deleted so the row survives to be joined.
create table notification_intents (
  id uuid primary key,
  org_id uuid not null references orgs (id) on delete cascade,
  -- the notification kind. v1: 'destination_disabled'. Extensible without a schema change.
  kind text not null,
  -- the destination this notification is about (nullable for future kinds without a destination). MATCH
  -- SIMPLE: a null destination_id skips the composite-FK check.
  destination_id uuid,
  -- 'pending' = not yet emailed; 'sent' = the notifier delivered it. The notifier reads pending, emails, and
  -- flips to sent (a single-flight guarded update) so an owner is emailed at most once per intent.
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint notification_intents_status_check check (status in ('pending', 'sent')),
  foreign key (destination_id, org_id) references replay_destinations (id, org_id) on delete cascade
);
-- The notifier's hot query: pending intents, oldest first. Partial so it stays small as sent rows accumulate.
create index notification_intents_pending_idx on notification_intents (created_at) where status = 'pending';
alter table notification_intents enable row level security;
alter table notification_intents force row level security;
create policy notification_intents_select on notification_intents for select using (org_id = current_org_id());
create policy notification_intents_insert on notification_intents for insert with check (org_id = current_org_id());
create policy notification_intents_update on notification_intents for update using (org_id = current_org_id()) with check (org_id = current_org_id());
create policy notification_intents_delete on notification_intents for delete using (org_id = current_org_id());
grant select, insert, update, delete on notification_intents to webhook_app;

-- migrate:down

drop table if exists notification_intents;
