-- migrate:up

-- Notification context snapshot (S3 Slice 3 PR3c-3b). The auto-disable notification email is informative —
-- it names the destination, the failure count, and the last error. But the webhook_notifier role that drains
-- intents is deliberately minimal: it can't read a destination's URL or a delivery's error (least privilege).
-- Rather than broaden that role, the ENGINE — which already holds the destination + the failing delivery when
-- it auto-disables — snapshots that context onto the intent row IN THE SAME tx. The notifier then reads a
-- self-contained snapshot. jsonb (one nullable column) keeps it extensible for future notification kinds
-- without another migration, and keeps the notifier's grant to a single column.
--
-- Shape written by the engine for `destination_disabled`:
--   { "destinationUrl": text, "failureCount": int, "lastError": text|null, "lastStatusCode": int|null }
-- Nullable: pre-existing intents (and any future kind that omits context) simply carry null.
alter table notification_intents add column context jsonb;

-- Extend the notifier's column-scoped SELECT grant to include the snapshot (additive to migration 0034's
-- grant). The role still cannot read the destination URL from replay_destinations or the error from
-- delivery_attempts — only this self-contained, engine-authored snapshot.
grant select (context) on notification_intents to webhook_notifier;

-- migrate:down

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'webhook_notifier') then
    revoke select (context) on notification_intents from webhook_notifier;
  end if;
end
$$;
alter table notification_intents drop column context;
