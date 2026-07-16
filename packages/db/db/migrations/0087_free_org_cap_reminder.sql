-- migrate:up

-- Two founder decisions coming out of PR2b slice 4's review (2026-07-16).
--
-- 1. DROP `orgs.restore_deadline`. 0083 introduced it as "the informational 'restore-by' date shown to the
--    user (a later slice hard-deletes past it)". That later slice was never built, and nothing ever read the
--    column: `restoreOrgFromFreeCap` gates on status + reason alone, no prune consults it, and no surface
--    displays it. So it bounded nothing — restoration is available indefinitely — while reading like a real
--    expiry to anyone who found it. It cost us two rounds of review: copy that promised "we're keeping it
--    until <deadline>" and then copy that threatened "you have until <deadline>", both false, both sourced
--    from a column that looked authoritative and wasn't. A write-only column that implies a policy we don't
--    enforce is worse than no column. If a real hard-delete lands, reintroduce it THEN, with its reader.
--
-- 2. ADD `orgs.free_org_cap_reminded_at`. The cap WARNING is the only notice before a suspension, and it
--    rides an at-most-once drain (the intent is claimed pending→sent BEFORE the Resend call, so a single 5xx
--    loses it permanently — see notify-cron.ts). One lost warning = an org suspended in silence, which is the
--    exact outcome this family exists to prevent. The plan's answer is a T-7-day reminder: a SECOND,
--    independently-sent notice, so no single send failure can swallow the warning entirely. This column is
--    what makes it fire exactly once per grace window (nullable = not yet reminded; cleared whenever the
--    grace window is cleared, so a re-flag later re-reminds).
--
-- The reminder's own kind (`free_org_cap_reminder`) needs no schema change — `notification_intents.kind` is
-- deliberately unconstrained (0032).

-- EXPAND→CONTRACT, deliberately waived (data.mdc forbids a drop in the release that stops writing the
-- column). The rule's hazard is the still-deployed old code writing a column the migration just removed.
-- That cannot happen here: the ONLY writer of restore_deadline is suspendOrgForFreeCap, reachable only from
-- runFreeOrgCapReconcile, reachable only from runFreeOrgCapCron — which returns immediately while
-- HYPERDRIVE_CAPRECONCILER is unset. The whole cap engine is dark and stays dark until after this deploy, so
-- no deployed code path touches the column in the migrate-then-deploy window. If the cron were live, this
-- would need to be two releases.
alter table orgs drop column restore_deadline;
alter table orgs add column free_org_cap_reminded_at timestamptz;

-- Coherence, mirroring 0083's `orgs_suspension_coherent`: reminded-ness is a property OF a grace window, so
-- "reminded but not in a window" is made unrepresentable rather than left to convention across four writers.
-- Load-bearing: a stranded `reminded_at` makes the org's NEXT grace window skip its reminder silently,
-- leaving that owner a single notice on an at-most-once pipeline — and `reminded: 0` looks identical to a
-- quiet pass, so nothing would surface it.
alter table orgs
  add constraint orgs_free_cap_reminder_coherent check (
    free_org_cap_reminded_at is null or free_org_cap_grace_until is not null
  );

-- The reconciler reads it to decide whether the reminder is still owed, and stamps it when it sends. Same
-- role-targeted policies as 0084/0085 — this only widens the existing column grants.
grant select (free_org_cap_reminded_at) on orgs to webhook_capreconciler;
grant update (free_org_cap_reminded_at) on orgs to webhook_capreconciler;

-- migrate:down

revoke select (free_org_cap_reminded_at) on orgs from webhook_capreconciler;
revoke update (free_org_cap_reminded_at) on orgs from webhook_capreconciler;
alter table orgs drop constraint orgs_free_cap_reminder_coherent;
alter table orgs drop column free_org_cap_reminded_at;

-- Restore 0083's column AND 0085's grant on it, so up→down leaves the exact pre-0087 state (0085's own down
-- then revokes it). Dropping a column drops its grants with it, so re-adding the column is not enough.
alter table orgs add column restore_deadline timestamptz;
grant update (restore_deadline) on orgs to webhook_capreconciler;
