-- migrate:up

-- Free-org-cap notifications (PR2b slice 4): let the reconciler ANNOUNCE what it is about to do, and let the
-- notifier NAME the org it is announcing about.
--
-- Two grants, each closing one half of a gap that only exists for this cap family.
--
-- 1. webhook_capreconciler -> INSERT on notification_intents.
--    A suspension the owner is never told about is the worst possible version of this feature, so the grace
--    flag and the suspend each enqueue their own intent IN THE SAME tx as the write (the destination_disabled
--    precedent, delivery.ts). Only INSERT: the reconciler must not read other orgs' intents (that is the
--    notifier's job), must not re-open a sent one, and must not clear the backlog. `status` is deliberately
--    NOT in the column grant — without it the reconciler cannot mint an already-'sent' intent and thereby
--    suppress its own notification; the column default ('pending') is the only value it can produce. It also
--    means the INSERT cannot use RETURNING (that needs SELECT), which is why the producer in org-lifecycle.ts
--    inserts blind rather than reusing insertNotificationIntent.
--
-- 2. webhook_notifier -> SELECT (id, name, slug) on orgs.
--    The three pre-existing kinds are produced by webhook_app, which can read orgs.name for free, so they
--    snapshot display data into `context` (0035) and the notifier never needed `orgs`. The cap kinds are
--    produced by webhook_capreconciler, whose grant deliberately stops at (id, created_at, status,
--    suspended_reason, free_org_cap_grace_until) — it can read neither `name` nor `slug`, so it CANNOT
--    snapshot them. Closing that gap means widening exactly one of the two roles. Widening the notifier is
--    the smaller move: it already reads every org owner's email address cross-org (0034), so org display
--    identity is strictly less sensitive than what it holds today, whereas teaching the SUSPENSION engine to
--    read org names would erode the least-privilege fence that is the whole point of that role. The grant is
--    display identity ONLY — not status, not the suspension columns, not created_at — so the notifier still
--    cannot observe org state, and it gets no write. rls.test.ts pins both the positives and the negatives.
--
--    BLAST RADIUS, accepted: listPendingNotifications is the single read behind ALL notification kinds, and
--    it now joins `orgs` unconditionally — so on a database where this grant is missing but the auth worker
--    has shipped, the drain throws `permission denied for table orgs`, runNotificationDrain logs + swallows,
--    and EVERY kind (not just the two new ones) silently stops mailing. This is the same code-ahead-of-schema
--    hazard every migration in this repo carries, and it is held by the same control: deploy-auth.yml runs the
--    migration-guard action, which blocks the deploy while HEAD is ahead of the `prod-schema` tag by an
--    unapplied migration. Sequence this migration ahead of the auth deploy, as usual.

-- Role-targeted, never a bare policy another role could ride. INSERT policies take only WITH CHECK.
create policy notification_intents_capreconciler_insert on notification_intents
  for insert to webhook_capreconciler with check (true);
create policy orgs_notifier_select on orgs
  for select to webhook_notifier using (true);

grant insert (id, org_id, kind, destination_id, context) on notification_intents to webhook_capreconciler;
grant select (id, name, slug) on orgs to webhook_notifier;

-- migrate:down

revoke insert (id, org_id, kind, destination_id, context) on notification_intents from webhook_capreconciler;
revoke select (id, name, slug) on orgs from webhook_notifier;
drop policy if exists notification_intents_capreconciler_insert on notification_intents;
drop policy if exists orgs_notifier_select on orgs;
