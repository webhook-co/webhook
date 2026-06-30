// Delivery subscriptions (S3 Slice 3 PR2): the Tier-3 routing model that selects which captured events
// auto-deliver to which destinations. A subscription is a (source endpoint → destination) join selecting on
// provider + event_types + require_verified (AND-combined). This module holds the PURE matcher plus the
// schema CRUD + the per-endpoint ingest resolver. Matching is set/glob math over fields WE derive (provider,
// the normalized event_type, the verified flag) — never a deep walk of the untrusted payload.

import { newId } from "@webhook-co/shared";

import { appendAuditEntry } from "./audit-append";
import { withTenant, type Sql, type TenantTx } from "./client";
import { getReplayDestination } from "./replay-destinations";

/** The event facts the matcher needs (a projection of the events row). */
export interface MatchableEvent {
  readonly provider: string;
  /** The normalized, per-provider-derived event type; null when we couldn't extract one (routes via `*`). */
  readonly eventType: string | null;
  /** Whether the event's signature was verified (the `verified` flag / verificationState === 'verified'). */
  readonly verified: boolean;
}

/** The subscription's selectors (a projection of the delivery_subscriptions row). */
export interface SubscriptionSelector {
  /** null = match any provider; otherwise the event's provider must equal this. */
  readonly provider: string | null;
  /** Patterns: an exact type, a trailing glob `charge.*`, or `*` (all). Default `['*']`. */
  readonly eventTypes: readonly string[];
  /** When true, only verified events match. */
  readonly requireVerified: boolean;
  /** A disabled subscription never matches. */
  readonly enabled: boolean;
}

/** One event_types pattern against one (possibly-null) event type. `*` matches anything incl. null; a null
 *  type matches ONLY `*`; a trailing-glob `x.*` matches every dotted child of `x.`; else an exact compare. */
function matchEventTypePattern(pattern: string, eventType: string | null): boolean {
  if (pattern === "*") return true;
  if (eventType === null) return false; // a null (unextracted) type matches only `*`
  if (pattern.endsWith(".*")) return eventType.startsWith(pattern.slice(0, -1)); // `charge.` prefix
  return pattern === eventType;
}

/**
 * Whether event E delivers to subscription S. ALL axes must hold:
 *   1. provider — S.provider is null OR equals E.provider
 *   2. event_types — some pattern in S.event_types matches E.eventType (see {@link matchEventTypePattern})
 *   3. require_verified — !S.requireVerified OR E.verified
 *   4. enabled — S.enabled
 * (The reserved `channels` / content-`filter` axes are not evaluated in v1.) An empty event_types list is a
 * degenerate "matches nothing" — the schema default is `['*']`, so it never occurs in practice.
 */
export function matchSubscription(event: MatchableEvent, sub: SubscriptionSelector): boolean {
  if (!sub.enabled) return false;
  if (sub.provider !== null && sub.provider !== event.provider) return false;
  if (sub.requireVerified && !event.verified) return false;
  return sub.eventTypes.some((pattern) => matchEventTypePattern(pattern, event.eventType));
}

// ---------------------------------------------------------------------------------------------------------
// Schema CRUD + the ingest resolver (webhook_app under the org's RLS context).
// ---------------------------------------------------------------------------------------------------------

/** The management view of a subscription. */
export interface SubscriptionRecord {
  readonly id: string;
  readonly orgId: string;
  readonly sourceEndpointId: string;
  readonly destinationId: string;
  readonly provider: string | null;
  readonly eventTypes: readonly string[];
  readonly requireVerified: boolean;
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface SubscriptionRow {
  id: string;
  org_id: string;
  source_endpoint_id: string;
  destination_id: string;
  provider: string | null;
  event_types: string[];
  require_verified: boolean;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

const SUB_COLS =
  "id, org_id, source_endpoint_id, destination_id, provider, event_types, require_verified, enabled, created_at, updated_at";

function toRecord(r: SubscriptionRow): SubscriptionRecord {
  return {
    id: r.id,
    orgId: r.org_id,
    sourceEndpointId: r.source_endpoint_id,
    destinationId: r.destination_id,
    provider: r.provider,
    eventTypes: r.event_types,
    requireVerified: r.require_verified,
    enabled: r.enabled,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Optional tamper-evident audit context for a subscription mutation. */
export interface SubscriptionAudit {
  readonly auditKey: CryptoKey;
  readonly actor: string | null;
}

export interface CreateSubscriptionInput {
  readonly orgId: string;
  readonly sourceEndpointId: string;
  readonly destinationId: string;
  /** null (default) = match any provider. */
  readonly provider?: string | null;
  /** Default `['*']` (match all event types). */
  readonly eventTypes?: readonly string[];
  /** Default false. */
  readonly requireVerified?: boolean;
}

/**
 * Create (or update the selectors of) the subscription for a (org, source endpoint, destination) triple.
 * The source endpoint and destination must both be LIVE (not soft-deleted) and same-org — a dead/cross-org
 * target is rejected up front (instead of binding a subscription that could never deliver, since the ingest
 * resolver excludes dead targets). A binding to a temporarily-DISABLED destination is allowed: it resumes
 * when the destination is re-enabled (mirrors the resolver, which excludes disabled only while disabled).
 *
 * UPSERTS on the triple via a deterministic two-step (insert-on-conflict-do-nothing, else update) so the
 * insert-vs-update outcome — and thus the audit action (`delivery_subscription.created` vs `.updated`) — is
 * exact under concurrency. An UPDATE overwrites provider/event_types/require_verified but PRESERVES `enabled`
 * (editing a paused subscription's selectors must not silently un-pause it). An empty/omitted event_types
 * defaults to `['*']` (match-all) rather than the degenerate match-nothing; non-string patterns are rejected.
 */
export async function createSubscription(
  app: Sql,
  input: CreateSubscriptionInput,
  audit?: SubscriptionAudit,
): Promise<SubscriptionRecord> {
  const id = newId();
  const provider = input.provider ?? null;
  const eventTypes = input.eventTypes && input.eventTypes.length > 0 ? input.eventTypes : ["*"];
  if (eventTypes.some((t) => typeof t !== "string")) {
    throw new Error("createSubscription: eventTypes must all be strings");
  }
  const requireVerified = input.requireVerified ?? false;
  return withTenant(app, input.orgId, async (tx) => {
    // Reject a dead/cross-org target before binding (RLS hides a cross-org row, so it resolves to null too).
    if ((await getReplayDestination(tx, input.destinationId)) === null) {
      throw new Error(
        `createSubscription: destination ${input.destinationId} not found, deleted, or cross-org`,
      );
    }
    const [endpoint] = await tx<{ id: string }[]>`
      select id from endpoints where id = ${input.sourceEndpointId} and deleted_at is null`;
    if (endpoint === undefined) {
      throw new Error(
        `createSubscription: source endpoint ${input.sourceEndpointId} not found, deleted, or cross-org`,
      );
    }

    const [inserted] = await tx<SubscriptionRow[]>`
      insert into delivery_subscriptions
        (id, org_id, source_endpoint_id, destination_id, provider, event_types, require_verified)
      values
        (${id}, ${input.orgId}, ${input.sourceEndpointId}, ${input.destinationId}, ${provider},
         ${tx.json([...eventTypes])}, ${requireVerified})
      on conflict (org_id, source_endpoint_id, destination_id) do nothing
      returning ${tx.unsafe(SUB_COLS)}`;
    const row =
      inserted ??
      (
        await tx<SubscriptionRow[]>`
          update delivery_subscriptions
             set provider = ${provider},
                 event_types = ${tx.json([...eventTypes])},
                 require_verified = ${requireVerified},
                 updated_at = now()
           where org_id = ${input.orgId}
             and source_endpoint_id = ${input.sourceEndpointId}
             and destination_id = ${input.destinationId}
          returning ${tx.unsafe(SUB_COLS)}`
      )[0];
    if (!row) throw new Error("createSubscription: conflict without an existing row");
    if (audit) {
      await appendAuditEntry(tx, audit.auditKey, {
        orgId: input.orgId,
        actor: audit.actor,
        action: inserted ? "delivery_subscription.created" : "delivery_subscription.updated",
        target: row.id,
      });
    }
    return toRecord(row);
  });
}

/** List an org's subscriptions (optionally filtered to one source endpoint), newest first, under RLS. */
export async function listSubscriptions(
  app: Sql,
  orgId: string,
  sourceEndpointId?: string,
): Promise<SubscriptionRecord[]> {
  const rows = await withTenant(app, orgId, (tx) =>
    sourceEndpointId === undefined
      ? tx<SubscriptionRow[]>`
          select ${tx.unsafe(SUB_COLS)} from delivery_subscriptions
          order by created_at desc, id desc`
      : tx<SubscriptionRow[]>`
          select ${tx.unsafe(SUB_COLS)} from delivery_subscriptions
          where source_endpoint_id = ${sourceEndpointId}
          order by created_at desc, id desc`,
  );
  return rows.map(toRecord);
}

/**
 * Hard-delete a subscription under the org's RLS context. Returns `{ id }` if a row belonging to the org was
 * removed, or null (unknown / cross-org / already-gone). A delete that transitioned a row appends a
 * `delivery_subscription.removed` audit entry when `audit` is supplied.
 */
export async function deleteSubscription(
  app: Sql,
  orgId: string,
  id: string,
  audit?: SubscriptionAudit,
): Promise<{ readonly id: string } | null> {
  return withTenant(app, orgId, async (tx) => {
    const removed = await tx<{ id: string }[]>`
      delete from delivery_subscriptions where id = ${id} returning id`;
    if (removed.length === 0) return null;
    if (audit) {
      await appendAuditEntry(tx, audit.auditKey, {
        orgId,
        actor: audit.actor,
        action: "delivery_subscription.removed",
        target: id,
      });
    }
    return { id };
  });
}

/**
 * The ingest resolver: an event's matching subscriptions on its source endpoint. Reads the endpoint's ENABLED
 * subscriptions that route to a LIVE destination (not soft-deleted, not disabled), then applies the pure
 * matcher. Takes a TenantTx so it runs under the org's RLS context; PR2c establishes that context (the
 * production ingest is a single-statement `SELECT ingest_event(...)`, so PR2c resolves matches via its own
 * `withTenant` read AFTER the event is durable — auto-delivery is post-ACK best-effort, not the hot path).
 * Each returned subscription becomes one independent queued delivery (PR2c).
 */
export async function listMatchingSubscriptions(
  tx: TenantTx,
  args: { orgId: string; sourceEndpointId: string; event: MatchableEvent },
): Promise<SubscriptionRecord[]> {
  const rows = await tx<SubscriptionRow[]>`
    select ${tx.unsafe(
      SUB_COLS.split(", ")
        .map((c) => `s.${c}`)
        .join(", "),
    )}
    from delivery_subscriptions s
    join replay_destinations d on d.id = s.destination_id and d.org_id = s.org_id
    where s.org_id = ${args.orgId}
      and s.source_endpoint_id = ${args.sourceEndpointId}
      and s.enabled
      and d.deleted_at is null
      and d.disabled_at is null
    order by s.created_at asc, s.id asc`;
  return rows.map(toRecord).filter((sub) => matchSubscription(args.event, sub));
}
