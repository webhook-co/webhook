# ADR 0004 — audit chain is HMAC-keyed and WORM head-anchored

- status: accepted
- date: 2026-06-12
- scope: `packages/db`, `packages/shared`
- review id: H2 (high)

## context

The control-plane audit log must be tamper-evident from day one (compliance-by-design).
A plain hash chain (`row_hash = H(prev_hash || fields)`) detects edits only if the
attacker can't recompute the chain — but if the hashing is unkeyed and the attacker can
write to the database, they can rewrite history *and* recompute a valid-looking chain.
Truncation (lopping off the tail) is also undetectable without an external anchor.

## decision

- **HMAC-keyed chain.** `row_hash = HMAC(key, prev_hash || canonical(fields))` where the
  **HMAC key lives outside the database role**. A database compromise alone can't forge
  a chain. The canonical, length-prefixed serialization is frozen in
  `packages/shared` (`audit.ts`) so the chain is reproducible across surfaces and by the
  (post-freeze) verifier.
- **Per-org monotonic sequence.** Each row carries a contiguous per-org `seq`; the chain
  is per-org (a global chain would serialize all audit writes system-wide). The database
  enforces the structure: a trigger requires contiguous `seq` + `prev_hash` linkage, and
  an immutability trigger rejects `UPDATE`/`DELETE`/`TRUNCATE` (proven against a
  superuser in the leak suite). The unique `(org_id, seq)` is the serialization point.
- **WORM head-anchor (designed now, cron later).** Periodically anchor the per-org chain
  head to R2 Object Lock so tail-truncation is detectable. Fields are frozen now; the
  cron implementation is post-freeze.
- **Pseudonymous actor (M1).** `actor` is the Better Auth `user_id`, never raw PII, and
  is not a FK — user erasure never deletes audit history.
- **Control-plane only.** The chain records low-volume control actions; per-event
  capture stays in `events` / `delivery_attempts`, off the chain's serialized write path.

## consequences

- Edits, forgeries, and truncation are detectable; the chain survives a DB-role
  compromise because the key is external.
- `created_at` is DB-stamped and excluded from the hash (immutability protects it).
- Schema + triggers: migration `0005_audit_log.sql`; serialization + verify:
  `packages/shared/src/audit.ts`. Recorded in `docs/threat-model.md`.
