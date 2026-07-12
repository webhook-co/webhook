-- migrate:up

-- delivery_attempts.duration_ms — how long the outbound POST took, in milliseconds.
--
-- The engine ALREADY measures this: guardedDeliver times the whole guarded POST and returns `latencyMs` on
-- the DeliverResult. Until now the drain read only the outcome and DROPPED the timing. This column captures
-- it so the /dashboard overview can show a p95 latency tile (computed at rollup time over delivered rows).
--
-- Forward-only, NO backfill: the timing does not exist for any delivery recorded before this, so those rows
-- keep `duration_ms = null` — which reads honestly as "we didn't measure it" rather than a fabricated zero.
-- The p95 tile shows "—" until enough new deliveries accrue. Nullable, no default, no table rewrite: a plain
-- metadata-only ALTER.
--
-- It is set on the SAME update that finalizes/reschedules a delivery (delivered / dead / blocked / pending),
-- so it costs no extra write; a pre-delivery refusal (a tombstoned/forged event never handed to the POST)
-- correctly leaves it null (no request was made).
alter table delivery_attempts
  add column duration_ms integer;

-- migrate:down

alter table delivery_attempts drop column if exists duration_ms;
