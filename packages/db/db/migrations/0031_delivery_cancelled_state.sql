-- migrate:up

-- S3 Slice 3 PR3b (destination lifecycle): a delivery reaches a NEW terminal state `cancelled` when its
-- destination is deleted while the delivery is still open (queued/pending) — so a deleted destination's owed
-- deliveries are terminally resolved instead of sitting durably owed forever (PR1b review carry-over #1b).
-- Distinct from `dead` (retries exhausted) and `blocked` (a real SSRF refusal): `cancelled` = the target went
-- away, no attempt was owed. Plus the strict-FIFO barrier's covering index (PR1b carry-over #3).

-- Widen the status CHECK with `cancelled`. Every existing row is one of the 0027 states, so it validates
-- cleanly (a plain ADD CONSTRAINT — delivery_attempts is small; revisit NOT VALID + VALIDATE at scale).
alter table delivery_attempts drop constraint delivery_attempts_status_check;
alter table delivery_attempts
  add constraint delivery_attempts_status_check
  check (status in ('queued', 'forwarded', 'pending', 'delivered', 'failed', 'blocked', 'dead', 'cancelled'));

-- The strict-FIFO (`ordered`) head-of-line barrier in listDueDeliveries keys on (created_at, id) over the
-- destination's OPEN deliveries (its `not exists` subquery). delivery_attempts_due_idx (destination_id,
-- next_retry_at) does NOT cover (created_at, id), so a large ordered backlog behind a stuck head did heap
-- lookups (PR1b carry-over #3). This partial index (open states only, so it stays small as terminal rows
-- accumulate) covers the barrier's ordering on RAW created_at (the barrier compares raw columns, no
-- date_trunc). NB the deliveries.list browse orders by date_trunc('ms', created_at) — a STABLE expression
-- that can't be a plain index — so its covering index is a separate expression-index perf follow-up.
create index delivery_attempts_ordered_idx
  on delivery_attempts (destination_id, created_at, id)
  where status in ('queued', 'pending');

-- migrate:down

drop index if exists delivery_attempts_ordered_idx;
-- Map `cancelled` back onto the pre-PR3b vocabulary BEFORE re-narrowing the CHECK, so the rollback is
-- executable + lossless even after cancellations have landed: cancelled (target removed) -> failed (terminal
-- non-delivery). Without this remap the narrow CHECK's validation scan would abort on any cancelled row.
update delivery_attempts set status = 'failed' where status = 'cancelled';
alter table delivery_attempts drop constraint if exists delivery_attempts_status_check;
alter table delivery_attempts
  add constraint delivery_attempts_status_check
  check (status in ('queued', 'forwarded', 'pending', 'delivered', 'failed', 'blocked', 'dead'));
