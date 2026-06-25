// The api-only events.replay handler + the delivery_attempts writer (H6). The CLI performs the
// localhost POST (the api can't reach a user's machine) and calls events.replay AFTER a local 2xx, so
// a delivery_attempts row is the durable audit + idempotency record of a successful forward. The
// frozen capability input ({eventId, target, idempotencyKey}) carries no HTTP outcome, so `status` is
// "forwarded" and `status_code` stays null — the live local response is shown by the CLI. mcp is
// exempt (the localhost-tunnel target is CLI-intrinsic); only apps/api binds this.

import { CapabilityFault, eventsReplay, type AuthContext, type Target } from "@webhook-co/contract";
import type { DeliveryAttempt } from "@webhook-co/shared";

import { withTenant, type Sql, type TenantTx } from "./client";
import { getEndpoint, getEvent } from "./reads";

interface DeliveryAttemptRow {
  id: string;
  org_id: string;
  event_id: string;
  target: string;
  idempotency_key: string | null;
  status: string;
  status_code: number | null;
  attempt: number;
  error: string | null;
  created_at: Date;
}

function toDeliveryAttempt(r: DeliveryAttemptRow): DeliveryAttempt {
  return {
    id: r.id,
    orgId: r.org_id,
    eventId: r.event_id,
    target: r.target,
    idempotencyKey: r.idempotency_key,
    status: r.status,
    statusCode: r.status_code,
    attempt: r.attempt,
    error: r.error,
    createdAt: r.created_at,
  };
}

export interface RecordDeliveryAttemptInput {
  readonly orgId: string;
  readonly eventId: string;
  readonly target: string;
  readonly idempotencyKey: string | null;
  readonly status: string;
  readonly statusCode?: number | null;
  readonly error?: string | null;
}

/**
 * Insert a delivery_attempts row, idempotent on (org_id, idempotency_key) (H6): a retry with the same
 * key returns the EXISTING row instead of inserting a duplicate. A null key never conflicts (the
 * partial unique index). RLS pins the org; the FK (event_id, org_id) guarantees the event is same-org.
 */
export async function recordDeliveryAttempt(
  tx: TenantTx,
  input: RecordDeliveryAttemptInput,
): Promise<DeliveryAttempt> {
  const [row] = await tx<DeliveryAttemptRow[]>`
    insert into delivery_attempts
      (id, org_id, event_id, target, idempotency_key, status, status_code, error)
    values
      (${crypto.randomUUID()}, ${input.orgId}, ${input.eventId}, ${input.target},
       ${input.idempotencyKey}, ${input.status}, ${input.statusCode ?? null}, ${input.error ?? null})
    on conflict (org_id, idempotency_key) where idempotency_key is not null do nothing
    returning id, org_id, event_id, target, idempotency_key, status, status_code, attempt, error, created_at`;
  if (row) return toDeliveryAttempt(row);
  // Conflict: this idempotency key was already recorded — return that attempt (idempotent replay).
  const [existing] = await tx<DeliveryAttemptRow[]>`
    select id, org_id, event_id, target, idempotency_key, status, status_code, attempt, error, created_at
    from delivery_attempts
    where org_id = ${input.orgId} and idempotency_key = ${input.idempotencyKey}`;
  if (!existing) throw new Error("delivery_attempts conflict without an existing row");
  return toDeliveryAttempt(existing);
}

/** Serialize a replay Target to the delivery_attempts.target text column (round-trippable JSON). */
function serializeTarget(target: Target): string {
  return JSON.stringify(target);
}

export type ReplayHandler = (ctx: AuthContext, input: unknown) => Promise<DeliveryAttempt>;

/**
 * The api-only events.replay handler. Enforces the events:replay scope, validates input, then under
 * the org's RLS: NOT_FOUND if the event is invisible, ENDPOINT_PAUSED if its endpoint is paused, else
 * records a "forwarded" delivery_attempt (idempotent) and returns the contract DeliveryAttempt. NOT in
 * the shared read-handler map (mcp must not bind it — localhost-tunnel is CLI-intrinsic); apps/api
 * dispatches it directly.
 */
export function createReplayHandler(deps: { readonly tenant: Sql }): ReplayHandler {
  return async (ctx, input) => {
    if (!ctx.scopes.includes(eventsReplay.auth.scope)) {
      throw new CapabilityFault("FORBIDDEN", `missing required scope: ${eventsReplay.auth.scope}`);
    }
    const parsed = eventsReplay.input.safeParse(input);
    if (!parsed.success) throw new CapabilityFault("VALIDATION_ERROR", "invalid input");
    const { eventId, target, idempotencyKey } = parsed.data;

    return withTenant(deps.tenant, ctx.orgId, async (tx) => {
      const event = await getEvent(tx, eventId);
      if (!event) throw new CapabilityFault("NOT_FOUND", "event not found");
      // includeDeleted (ADR-0076): a soft-deleted endpoint's captured events are RETAINED and stay
      // REPLAYABLE — replay forwards the stored payload to localhost, not via the (dead) ingest URL.
      // (Without it, getEndpoint would filter the soft-deleted row and replay a retained event would
      // wrongly 404.) The FK guarantees the endpoint exists; treat an unexpected miss as NOT_FOUND.
      const endpoint = await getEndpoint(tx, event.endpointId, { includeDeleted: true });
      if (!endpoint) throw new CapabilityFault("NOT_FOUND", "event not found");
      if (endpoint.paused) throw new CapabilityFault("ENDPOINT_PAUSED", "endpoint is paused");
      return recordDeliveryAttempt(tx, {
        orgId: ctx.orgId,
        eventId,
        target: serializeTarget(target),
        idempotencyKey,
        status: "forwarded",
      });
    });
  };
}
