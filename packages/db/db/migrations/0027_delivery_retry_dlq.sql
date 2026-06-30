-- migrate:up

-- S3 Slice 3: the outbound delivery engine's retry + dead-letter + per-destination ordering/disable state.
-- A delivery (one event→destination attempt-chain) is a single delivery_attempts row that advances through
-- attempts on the per-destination delivery DO's alarm clock. This migration adds the retry clock + two new
-- states; the subscription model + events.event_type land in a later migration (PR2).

-- delivery_attempts: the next-attempt time + the two new states.
--   queued  = durably accepted (enqueued), not yet attempted (the durable-before-ACK intent).
--   dead    = retries exhausted → dead-letter (DLQ); the row is retained for history + manual replay.
alter table delivery_attempts add column next_retry_at timestamptz;
alter table delivery_attempts drop constraint delivery_attempts_status_check;
alter table delivery_attempts
  add constraint delivery_attempts_status_check
  check (status in ('queued', 'forwarded', 'pending', 'delivered', 'failed', 'blocked', 'dead'));
-- The DO's hot query: this destination's due deliveries, soonest first. Partial (only the OPEN/owed states
-- queued + pending) so it stays small as delivered/dead/blocked rows accumulate. CONSUMER CONTRACT for the
-- DeliveryDO (PR1b) so this index is sufficient: a delivery RESTS as `pending` between attempts (a retryable
-- failure sets status='pending' + next_retry_at=next-slot — NOT 'failed'; `failed` stays the legacy 1b
-- one-shot terminal). `queued` rows MUST be enqueued with next_retry_at=now() (immediately due). The
-- due-query MUST treat a null next_retry_at as due (`next_retry_at is null or next_retry_at <= now()`) so a
-- freshly-queued row is never skipped. Exhaustion -> `dead`; a real SSRF refusal -> `blocked` (both terminal).
create index delivery_attempts_due_idx
  on delivery_attempts (destination_id, next_retry_at)
  where status in ('queued', 'pending');

-- replay_destinations: the per-destination strict-FIFO toggle + the auto-disable tally.
--   ordered               = strict in-order delivery (head-of-line blocking) vs the best-effort default.
--   consecutive_failures  = run of dead-lettered deliveries since the last success; resets to 0 on delivered.
--   disabled_at           = set when persistent failure trips the auto-disable; stops being an enqueue target.
alter table replay_destinations add column ordered boolean not null default false;
alter table replay_destinations add column consecutive_failures integer not null default 0;
alter table replay_destinations add column disabled_at timestamptz;

-- migrate:down
alter table replay_destinations drop column if exists disabled_at;
alter table replay_destinations drop column if exists consecutive_failures;
alter table replay_destinations drop column if exists ordered;
drop index if exists delivery_attempts_due_idx;
-- Map the two new states back onto the 0025 vocabulary BEFORE re-narrowing the CHECK, so the rollback is
-- executable + lossless even after deliveries have landed: queued (accepted, not yet attempted) -> pending
-- (in-flight); dead (retries exhausted) -> failed (terminal failure). Without this remap the narrow CHECK's
-- validation scan would abort the rollback on any queued/dead row.
update delivery_attempts set status = 'pending' where status = 'queued';
update delivery_attempts set status = 'failed' where status = 'dead';
alter table delivery_attempts drop constraint if exists delivery_attempts_status_check;
alter table delivery_attempts
  add constraint delivery_attempts_status_check
  check (status in ('forwarded', 'pending', 'delivered', 'failed', 'blocked'));
alter table delivery_attempts drop column if exists next_retry_at;
