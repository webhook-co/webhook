// events.delete as a TOMBSTONE (S3). A user deletes a captured event; a HARD delete would be a self-serve
// billing exploit (delivery_attempts cascades + both legs are metered → deleting recent events recomputes
// the bill down, evades the soft cap, poisons the F6 oracle) AND would free the unique(endpoint_id,
// dedup_key) slot so the same webhook could be re-ingested and re-billed. So this KEEPS the row (count(*)
// and the dedup slot stay intact) but marks it deleted, redacts the PII-bearing captured content in the same
// transaction, and enqueues the R2 body for async purge. Mirrors deleteEndpointWithAudit (ADR-0076).

// Leaf import (not the @webhook-co/contract barrel): apps/web pulls this module DB-direct under Turbopack,
// where a named binding from a transpiled-package `export *` barrel resolves to `undefined` at runtime — so
// `new CapabilityFault` would throw "not a constructor" on the RATE_LIMITED / NOT_FOUND path (see
// [[turbopack-contract-barrel]]).
import { CapabilityFault } from "@webhook-co/contract/capability";
import type { AuditActorInput } from "@webhook-co/shared";

import { appendAuditEntry } from "./audit-append";
import { withTenant, type Sql } from "./client";

/** The audit action a tombstone writes — a destructive act on captured data must be attributable + detectable,
 *  and it doubles as the counter for the per-org delete rate limit below. */
export const EVENT_DELETE_AUDIT_ACTION = "event.deleted";

/** Delete cap: at most this many event deletes per ORG per window. A destructive-op backstop — it bounds a
 *  runaway agent (an MCP tool acting on attacker-controlled payloads) or a compromised events:delete bearer
 *  hammering deletes, without impeding a legitimate interactive cleanup (5/sec is far above human use). Not a
 *  security boundary (the scope gate + audit trail are); a tiny check-then-append race may allow cap+N. */
export const EVENT_DELETE_MAX_PER_WINDOW = 300;
export const EVENT_DELETE_WINDOW_SECONDS = 60;

/**
 * Enforce the per-org delete rate limit BEFORE the tombstone. Counts recent `event.deleted` audit rows under
 * the org's RLS (webhook_app); over the cap → CapabilityFault RATE_LIMITED. Audit-derived (no new table) —
 * the rows the delete already writes are the counter, exactly like the ingest-URL-reveal limiter.
 */
export async function enforceEventDeleteRateLimit(app: Sql, orgId: string): Promise<void> {
  const rows = await withTenant(
    app,
    orgId,
    (tx) =>
      tx<{ count: number }[]>`
      select count(*)::int as count
      from audit_log
      where action = ${EVENT_DELETE_AUDIT_ACTION}
        and created_at > now() - make_interval(secs => ${EVENT_DELETE_WINDOW_SECONDS})`,
  );
  const count = rows[0]?.count ?? 0;
  if (count >= EVENT_DELETE_MAX_PER_WINDOW) {
    throw new CapabilityFault("RATE_LIMITED", "too many event deletes; please retry in a moment");
  }
}

export interface DeleteEventInput {
  readonly orgId: string;
  readonly eventId: string;
  /** Acting principal for the audit row — a typed actor, never a bare id (see audit-actor). */
  readonly actor: AuditActorInput;
}

export interface DeletedEventRow {
  readonly id: string;
  readonly deletedAt: Date;
  /** True iff THIS call performed the real transition (a first delete), false on an idempotent re-delete. */
  readonly wasLive: boolean;
}

/**
 * Tombstone an event + redact its captured content + enqueue its R2 body for purge + append the audit row,
 * in ONE tx under the org's RLS context (webhook_app). IDEMPOTENT: a re-delete of an already-deleted event
 * keeps its recorded deletedAt, re-redacts nothing, enqueues no duplicate purge, and appends no second audit
 * row (the transition happened once). An unknown / cross-org id is RLS-invisible → NOT_FOUND.
 *
 * The `cur` CTE snapshots the prior deleted_at + the R2 key/endpoint under `for update`, so two concurrent
 * first-deletes SERIALIZE (the second blocks, then sees prev_deleted_at non-null and is a no-op) — the
 * transition, the redaction, the purge enqueue, and the audit all happen exactly once. Every redaction
 * clause is guarded on the OLD deleted_at being null (an UPDATE's SET RHS sees the pre-update row), so a
 * re-delete never touches the already-redacted columns.
 *
 * NOT redacted: `dedup_key` (NOT NULL + part of unique(endpoint_id, dedup_key) — clearing it would free the
 * dedup slot and let the same webhook be re-ingested and re-billed; it is a dedup arbiter, not payload
 * content), and `payload_r2_key` (an opaque locator, kept to enqueue the purge; reads are filtered by
 * deleted_at so it is never surfaced, and the object it points at is purged).
 */
export async function deleteEventWithAudit(
  app: Sql,
  input: DeleteEventInput,
  auditKey: CryptoKey,
): Promise<DeletedEventRow> {
  return withTenant(app, input.orgId, async (tx) => {
    const rows = await tx<
      { deleted_at: Date; was_live: boolean; endpoint_id: string; payload_r2_key: string }[]
    >`
      with cur as (
        select id, deleted_at as prev_deleted_at, endpoint_id, payload_r2_key
        from events where id = ${input.eventId} for update
      )
      update events e
         set deleted_at        = coalesce(e.deleted_at, now()),
             headers           = case when e.deleted_at is null then '[]'::jsonb else e.headers end,
             verification      = case when e.deleted_at is null then null else e.verification end,
             external_id       = case when e.deleted_at is null then null else e.external_id end,
             provider_event_id = case when e.deleted_at is null then null else e.provider_event_id end,
             content_hash      = case when e.deleted_at is null then null else e.content_hash end,
             content_type      = case when e.deleted_at is null then null else e.content_type end,
             event_type        = case when e.deleted_at is null then null else e.event_type end,
             payload_r2_offset = case when e.deleted_at is null then null else e.payload_r2_offset end
        from cur
       where e.id = cur.id
      returning e.deleted_at, (cur.prev_deleted_at is null) as was_live,
                cur.endpoint_id, cur.payload_r2_key`;
    const row = rows[0];
    if (!row) throw new CapabilityFault("NOT_FOUND", "event not found");
    if (row.was_live) {
      // Enqueue the R2 body purge (idempotent on the event_id PK) and audit — the transition only.
      await tx`
        insert into event_payload_purge (event_id, org_id, endpoint_id, payload_r2_key)
        values (${input.eventId}, ${input.orgId}, ${row.endpoint_id}, ${row.payload_r2_key})
        on conflict (event_id) do nothing`;
      await appendAuditEntry(tx, auditKey, {
        orgId: input.orgId,
        actor: input.actor,
        action: EVENT_DELETE_AUDIT_ACTION,
        target: input.eventId,
      });
    }
    return { id: input.eventId, deletedAt: row.deleted_at, wasLive: row.was_live };
  });
}
