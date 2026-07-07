---
name: data-migration
description: Plan and run safe, reversible Postgres schema and data migrations. Use when adding/altering tables or columns, backfilling data, or changing the data model for the webhook metadata store.
---

# Data migration

Change the Neon Postgres schema (metadata, config, dedup/idempotency keys) without downtime or data
loss. Raw payloads live in R2, not Postgres — migrations touch metadata, not bodies.

## Expand → backfill → contract

Never do a breaking change in one step. Split across releases:

1. **Expand** — add new columns/tables (nullable/defaulted), additive only. Deploy. Nothing reads
   the new shape yet.
2. **Backfill** — populate new fields in idempotent, re-runnable batches, off the hot path. Never
   hold a long lock on a hot table.
3. **Contract** — switch reads/writes to the new shape, verify, then (in a later release) drop the
   old shape once rollback is no longer needed.

## Safety checklist

- [ ] Migration is idempotent and safe to re-run.
- [ ] Tenant isolation preserved: RLS policies updated for new/changed tables.
- [ ] No PII/PHI moved into logs; no raw payloads pulled into Postgres.
- [ ] Tested rollback path exists before production.
- [ ] **Audit log untouched** — never rewrite or delete hash-chained audit history.
- [ ] Metering data integrity preserved (event counts stay accurate, single-dimension, dedup-safe).

## Applying to prod (schema-before-deploy)

Migrations are applied **manually**, decoupled from CD, and **before** the code that depends on them
deploys. Apply with **`scripts/apply-prod-migrations.sh`** (with `DATABASE_URL` set to the prod
`webhook_owner` connection) — **not** a bare `dbmate up`. The script runs the migration **and** advances
the global `prod-schema` git tag to the applied commit.

That tag is the deploy **migration-guard**'s source of truth: the three deploy workflows
(`deploy.yml` / `deploy-web.yml` / `deploy-auth.yml`) block an **auto** deploy whenever `HEAD` is ahead of
`prod-schema` by a migration — so new code can never auto-deploy against an un-applied schema. If you apply
with a bare `dbmate up`, the tag doesn't move and the next migration-bearing push will be blocked with a
message telling you to run the script. Recovery from a block: run the script (applies + advances the tag),
then push — or `workflow_dispatch` to override (which does **not** move the tag, so it can't blind the guard).

**Trust anchor.** Because the guard trusts `prod-schema` as prod's applied-through marker, force-pushing it
without actually applying the migration would blind the guard (allow a deploy against an un-migrated schema).
The guard defends against *accidental* fail-opens, not a malicious repo-writer (who could edit the workflow
anyway). Defense-in-depth is **enforced**: a GitHub **tag ruleset** restricts create/update/delete of
`refs/tags/prod-schema` to repo admins (break-glass), so only an authorized admin running this script can
move it — a non-admin push to the tag is rejected.

## Guardrails

- Forward-only in spirit; reversible in practice. No destructive change in the same release that
  starts depending on the new shape.
- Large backfills are batched and resumable; monitor lock time and replication lag.

## Progressive disclosure

Put runnable migration templates, batching helpers, and a rollback drill in `references/`.
