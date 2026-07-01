// The delivery-attempt lifecycle the per-destination delivery DO drives (S3 Slice 3). A delivery is one
// (event → destination) attempt-chain, recorded as a single delivery_attempts row that advances through
// attempts on the DO's alarm clock. These helpers are the DO's claim/finalize seam over the state machine
// (migration 0027): `queued`/`pending` are the OPEN states (`attempt` = the 1-based attempt about to be
// made); terminal states are `delivered` (a 2xx), `dead` (retries exhausted → DLQ), and `blocked` (a real
// SSRF refusal). A delivery RESTS as `pending` between attempts (with next_retry_at set) — never `failed`
// (that stays the legacy 1b one-shot terminal). All run under the org's RLS context (webhook_app); the
// engine binds HYPERDRIVE_TENANT as webhook_app, so the DO writes these directly with no api callback.

import { type TenantTx } from "./client";
import { serializeTarget } from "./replay";

/** Input to enqueue ONE native auto-delivery (S3 Slice 3 PR2c): the event→destination attempt-chain a
 *  matching subscription selected. */
export interface QueuedDeliveryInput {
  readonly orgId: string;
  readonly eventId: string;
  readonly destinationId: string;
  /** The subscription that matched — recorded so a sub's delete can unlink its deliveries (trigger, mig 0030)
   *  and PR3's reads can attribute a delivery to its rule. */
  readonly subscriptionId: string;
}

/**
 * Insert a fresh `queued` delivery_attempts row for a native auto-delivery (S3 Slice 3 PR2c): one
 * event→destination attempt-chain selected by `subscriptionId`. Enqueued immediately-due
 * (next_retry_at = now(), status 'queued', attempt 1, claimed_at null) so the destination's DO drains it on
 * its next alarm (listDueDeliveries treats a queued row as due). `target` records the destination link
 * (round-trippable JSON, mirroring the remote-replay path so PR3's deliveries.list reads one shape);
 * idempotency_key stays null — auto-deliveries are append-only history, deduped UPSTREAM by the ingest gate
 * (auto-delivery runs only for a genuinely-new event, so each (event, subscription) yields exactly one row),
 * not by a key. Returns the new delivery_attempts row id (the STABLE Standard Webhooks `webhook-id`). The
 * composite FK (event_id, org_id) + RLS pin the event to the caller's org.
 */
export async function insertQueuedDelivery(
  tx: TenantTx,
  input: QueuedDeliveryInput,
): Promise<string> {
  // The destination link, serialized through the SHARED serializeTarget (the same serializer the remote-
  // replay producer uses) so delivery history has ONE un-driftable target shape across both producers.
  const target = serializeTarget({ kind: "destination", destinationId: input.destinationId });
  const [row] = await tx<{ id: string }[]>`
    insert into delivery_attempts
      (id, org_id, event_id, destination_id, subscription_id, target, status, attempt, next_retry_at)
    values
      (${crypto.randomUUID()}, ${input.orgId}, ${input.eventId}, ${input.destinationId},
       ${input.subscriptionId}, ${target}, 'queued', 1, now())
    returning id`;
  if (!row) throw new Error("insertQueuedDelivery: insert returned no row");
  return row.id;
}

/** A delivery that is DUE now (queued, or a retry whose next_retry_at has arrived), with the context the
 *  DO needs to build the outbound POST (the event's R2 key inputs + captured headers + the destination url). */
export interface DueDelivery {
  /** The delivery_attempts row id — also the STABLE Standard Webhooks `webhook-id` across all retries
   *  (so the receiver dedups a re-sent delivery; differs from Slice 2 remote-replay's per-attempt id). */
  readonly id: string;
  /** The 1-based attempt about to be made (1 on a fresh queued row, incremented as it's rescheduled). */
  readonly attempt: number;
  readonly eventId: string;
  readonly endpointId: string;
  readonly dedupKey: string;
  /** The event's captured headers ([name,value] pairs), forwarded (hop-by-hop dropped engine-side). */
  readonly headers: ReadonlyArray<readonly [string, string]>;
  /** The destination's canonical delivery URL. */
  readonly url: string;
}

interface DueDeliveryRow {
  id: string;
  attempt: number;
  event_id: string;
  endpoint_id: string;
  dedup_key: string;
  headers: [string, string][];
  url: string;
}

/**
 * The destination's DUE deliveries, FIFO (oldest first), within the caller's tenant tx. A delivery is due
 * when status ∈ (queued, pending) and (next_retry_at is null OR next_retry_at <= now). Served by
 * delivery_attempts_due_idx (migration 0027). Excludes a destination that is soft-deleted or disabled (it
 * stops being a delivery target). The `limit` bounds how many a single alarm drains.
 *
 * Strict-FIFO (a destination with `ordered = true`) needs a CROSS-CYCLE head-of-line gate, not just the
 * within-drain break: a retrying head sits `pending` with a future next_retry_at, so the plain due-filter
 * would skip it and surface a NEWER delivery — letting it jump ahead in a later alarm. So in ordered mode a
 * due row is withheld while ANY earlier still-open delivery is not yet due (the `not exists` barrier). For a
 * best-effort destination the barrier is bypassed and every due delivery is independent.
 */
export async function listDueDeliveries(
  tx: TenantTx,
  destinationId: string,
  limit = 50,
): Promise<DueDelivery[]> {
  const rows = await tx<DueDeliveryRow[]>`
    select da.id, da.attempt, da.event_id, e.endpoint_id, e.dedup_key, e.headers, d.url
    from delivery_attempts da
    join events e on e.id = da.event_id and e.org_id = da.org_id
    join replay_destinations d on d.id = da.destination_id and d.org_id = da.org_id
    where da.destination_id = ${destinationId}
      and da.status in ('queued', 'pending')
      and (da.next_retry_at is null or da.next_retry_at <= now())
      and d.deleted_at is null
      and d.disabled_at is null
      and (
        d.ordered = false
        or not exists (
          select 1
          from delivery_attempts blk
          where blk.destination_id = da.destination_id
            and blk.status in ('queued', 'pending')
            and blk.next_retry_at is not null
            and blk.next_retry_at > now()
            and (blk.created_at, blk.id) < (da.created_at, da.id)
        )
      )
    order by da.created_at asc, da.id asc
    limit ${limit}`;
  return rows.map((r) => ({
    id: r.id,
    attempt: r.attempt,
    eventId: r.event_id,
    endpointId: r.endpoint_id,
    dedupKey: r.dedup_key,
    headers: r.headers,
    url: r.url,
  }));
}

/** Whether the destination is in strict-FIFO (`ordered`) mode — the DO blocks newer deliveries behind a
 *  still-retrying head when true, else dispatches best-effort with independent retries. Default false. */
export async function isDestinationOrdered(tx: TenantTx, destinationId: string): Promise<boolean> {
  const [row] = await tx<{ ordered: boolean }[]>`
    select ordered from replay_destinations where id = ${destinationId}`;
  return row?.ordered ?? false;
}

/** When the DO should next wake to drive this destination, or null when there is nothing actionable — the
 *  DO re-arms its single alarm for this (one alarm/DO). A null next_retry_at (a freshly-queued, never-
 *  scheduled row) counts as due now. The query mirrors listDueDeliveries' liveness + ordering, so the
 *  re-arm and the drain never disagree:
 *   - a soft-deleted/disabled destination yields null (no live work) so the DO goes idle rather than
 *     spinning the alarm at now() over rows the drain will never surface. Any still-open deliveries to such
 *     a destination stay durably owed in Neon (never silently dropped) — resuming them when a destination is
 *     re-enabled and cancelling them when it is deleted is the lifecycle slice's job (PR3), which re-wakes
 *     the DO; PR1b's producer (PR2) does not yet exist, so this idle path is unreachable here;
 *   - best-effort re-arms for the SOONEST open delivery (deliveries are independent);
 *   - strict-ordered re-arms for the HEAD (oldest open) delivery's due time — a newer, sooner delivery must
 *     not pull the alarm earlier than the head it is blocked behind. */
export async function nextDueAt(tx: TenantTx, destinationId: string): Promise<Date | null> {
  const [row] = await tx<{ due: Date | null }[]>`
    select case
      when d.ordered then (
        select coalesce(da.next_retry_at, now())
        from delivery_attempts da
        where da.destination_id = d.id and da.status in ('queued', 'pending')
        order by da.created_at asc, da.id asc
        limit 1
      )
      else (
        select min(coalesce(da.next_retry_at, now()))
        from delivery_attempts da
        where da.destination_id = d.id and da.status in ('queued', 'pending')
      )
    end as due
    from replay_destinations d
    where d.id = ${destinationId} and d.deleted_at is null and d.disabled_at is null`;
  return row?.due ?? null;
}

/** Terminal success: status → delivered + reset the destination's consecutive-failure tally. Guarded on an
 *  OPEN status so a concurrent reconciler re-drive can't double-finalize. */
export async function markDeliveryDelivered(
  tx: TenantTx,
  input: { id: string; destinationId: string; attempt: number; statusCode: number },
): Promise<void> {
  const res = await tx`
    update delivery_attempts
       set status = 'delivered', attempt = ${input.attempt}, status_code = ${input.statusCode},
           error = null, next_retry_at = null
     where id = ${input.id} and status in ('queued', 'pending')`;
  if (res.count > 0) {
    await tx`update replay_destinations set consecutive_failures = 0 where id = ${input.destinationId}`;
  }
}

/** Retryable failure with a remaining slot: stays OWED as `pending`, scheduled at nextRetryAt, attempt
 *  advanced to the next attempt number. Does NOT touch the failure tally (only a terminal dead/blocked does). */
export async function scheduleDeliveryRetry(
  tx: TenantTx,
  input: {
    id: string;
    nextAttempt: number;
    nextRetryAt: Date;
    statusCode: number | null;
    error: string | null;
  },
): Promise<void> {
  await tx`
    update delivery_attempts
       set status = 'pending', attempt = ${input.nextAttempt}, next_retry_at = ${input.nextRetryAt},
           status_code = ${input.statusCode}, error = ${input.error}
     where id = ${input.id} and status in ('queued', 'pending')`;
}

/**
 * Terminally CANCEL a destination's still-open (queued/pending) deliveries (S3 Slice 3 PR3b): status →
 * `cancelled`, next_retry_at cleared. Called when the destination is deleted while deliveries are still owed
 * — otherwise the DO idles on a deleted destination and those rows sit owed forever (PR1b carry-over #1b).
 * Terminal rows (delivered/dead/blocked/failed) are untouched, so delivery HISTORY is preserved. Runs in the
 * caller's tenant tx (composes with the soft-delete in one transaction). Returns the number cancelled.
 */
export async function cancelOpenDeliveries(tx: TenantTx, destinationId: string): Promise<number> {
  const res = await tx`
    update delivery_attempts
       set status = 'cancelled', next_retry_at = null
     where destination_id = ${destinationId} and status in ('queued', 'pending')`;
  return res.count;
}

/** Terminal non-delivery: status → `dead` (retries exhausted) or `blocked` (a real SSRF refusal). Bumps the
 *  destination's consecutive-failure tally (the auto-disable signal, acted on in a later PR). */
export async function markDeliveryTerminalFailure(
  tx: TenantTx,
  input: {
    id: string;
    destinationId: string;
    status: "dead" | "blocked";
    attempt: number;
    statusCode: number | null;
    error: string | null;
  },
): Promise<void> {
  const res = await tx`
    update delivery_attempts
       set status = ${input.status}, attempt = ${input.attempt}, status_code = ${input.statusCode},
           error = ${input.error}, next_retry_at = null
     where id = ${input.id} and status in ('queued', 'pending')`;
  if (res.count > 0) {
    await tx`
      update replay_destinations
         set consecutive_failures = consecutive_failures + 1
       where id = ${input.destinationId}`;
  }
}
