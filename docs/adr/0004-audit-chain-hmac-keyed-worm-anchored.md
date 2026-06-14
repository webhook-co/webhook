# ADR 0004 — audit chain is HMAC-keyed and WORM head-anchored

- status: accepted
- date: 2026-06-12
- scope: `packages/db`, `packages/shared`
- review severity: high

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
  verifier.
- **Per-org monotonic sequence.** Each row carries a contiguous per-org `seq`; the chain
  is per-org (a global chain would serialize all audit writes system-wide). The database
  enforces the structure: a trigger requires contiguous `seq` + `prev_hash` linkage, and
  an immutability trigger rejects `UPDATE`/`DELETE`/`TRUNCATE` (proven against a
  superuser in the leak suite). The unique `(org_id, seq)` is the serialization point.
- **WORM head-anchor (serialized + cron).** Periodically anchor the per-org chain
  head to an **R2 bucket under a Bucket Lock** (write-once, no delete/overwrite for the
  retention period) so tail-truncation is detectable. Note R2 provides **Bucket Locks**
  (prefix/bucket retention rules), **not** S3 Object Lock — there is no compliance/governance
  mode; retention is uniformly enforced (no privileged override), which is the WORM property
  we need, and the anchor writer additionally holds no delete rights. The frozen anchor payload
  (`{version, orgId, seq, rowHash, anchoredAt}` + an HMAC under the chain key) lives in
  `packages/shared/src/audit-anchor.ts`; `verifyChainAgainstAnchor` cross-checks the live chain.
  The inherent detection window equals the cron interval (rows written *and* truncated entirely
  between two anchors were never captured).
- **Pseudonymous actor.** `actor` is the Better Auth `user_id`, never raw PII, and
  is not a FK — user erasure never deletes audit history.
- **Control-plane only.** The chain records low-volume control actions; per-event
  capture stays in `events` / `delivery_attempts`, off the chain's serialized write path.

## consequences

- Edits, forgeries, and truncation are detectable; the chain survives a DB-role
  compromise because the key is external.
- `created_at` is DB-stamped and excluded from the hash (immutability protects it).
- Schema + triggers: migration `0005_audit_log.sql`; serialization + verify:
  `packages/shared/src/audit.ts`. Recorded in `docs/threat-model.md`.
