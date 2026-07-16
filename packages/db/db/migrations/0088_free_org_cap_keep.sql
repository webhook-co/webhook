-- migrate:up

-- The free-org-cap KEEP mark (PR2b slice 5): let an owner choose which of their free orgs survive the cap,
-- instead of the reconciler's default of "keep the oldest `cap`, suspend the rest".
--
-- WHY A COLUMN ON `orgs`, AND NOT A PER-USER TABLE.
--
-- The cap is counted per OWNER, so the natural model is a `(user_id, org_id)` keep table — one user's picks,
-- independent of any co-owner's. That model is FORBIDDEN here, and deliberately: it would need a
-- `user_id = current_app_user()` policy on webhook_app, which is precisely the design ADR-0113 rejects.
-- Postgres policies are PERMISSIVE and OR together, so the moment such a policy exists, every membership read
-- that doesn't name `org_id` silently goes cross-org. 0067 documents the same trap; a lint rule guarding it
-- was tried and DELETED after a review reproduced four bypasses. The only per-user reach in this schema is
-- `user_org_directory()` — a zero-arg SECURITY DEFINER bounded by `current_app_user()` — and that is a READ.
--
-- So the mark is a property of the ORG, not of (user, org). webhook_app already holds table-wide UPDATE on
-- `orgs`, policed by `orgs_update`'s `id = current_org_id()`, so an owner sets this one org at a time under
-- that org's own tenant context — no new policy, no new reach. The visible consequence, which the UI states
-- plainly: on a CO-OWNED org, one owner's mark marks it for every owner. That reads as "this org matters",
-- which is a defensible thing for an org-level flag to mean.
--
-- A PREFERENCE, NOT A TRUTH. The web app can only write one org per transaction, so "at most `cap` marks per
-- user" cannot be enforced transactionally — a second tab, or a retry, can overshoot. The reconciler
-- therefore RE-VALIDATES rather than trusts: it sorts each owner's free orgs by (marked first, then oldest)
-- and still slices at `cap`. Marking everything is thereby identical to marking nothing, so the flag can
-- never be used to escape the cap — only to reorder who survives it. `orgs_capreconciler_select` (0084)
-- already grants the reconciler its cross-user reach; this only widens its column grant by one field.
--
-- Nullable timestamptz rather than boolean: null = unmarked (the default, and today's exact behaviour), and
-- the timestamp records WHEN the owner chose, which the picker shows and a future audit would want.

alter table orgs add column free_org_cap_keep_requested_at timestamptz;

grant select (free_org_cap_keep_requested_at) on orgs to webhook_capreconciler;

-- migrate:down

revoke select (free_org_cap_keep_requested_at) on orgs from webhook_capreconciler;
alter table orgs drop column free_org_cap_keep_requested_at;
