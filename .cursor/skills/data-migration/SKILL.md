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

## Guardrails

- Forward-only in spirit; reversible in practice. No destructive change in the same release that
  starts depending on the new shape.
- Large backfills are batched and resumable; monitor lock time and replication lag.

## Progressive disclosure

Put runnable migration templates, batching helpers, and a rollback drill in `references/`.
