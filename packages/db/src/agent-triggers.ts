// Agent triggers (S5): the webhook→agent trigger subscription registry. An agent trigger is a thin
// org-scoped (endpoint) binding that an authenticated principal creates so it can consume — via the
// triggers.wait SHORT-poll tool (Slice C), one fast scan per call, the caller drives the cadence (see
// the handler below) — the events its endpoint captures. It does not push or "wake" the agent. Unlike the egress
// delivery_subscriptions (which route events to third-party destinations and are mcp-EXEMPT for
// confused-deputy reasons), a trigger creates NO egress: it only lets the caller consume, over MCP, the
// same events it can already read (events:read). So the triggers.* capabilities are MCP-BOUND, and their
// handlers live on the SHARED buildCapabilityHandlers map (this factory is merged there) — the inverse of
// subscriptions', whose dedicated map keeps them off MCP.
//
// This module holds the schema CRUD (create / list / soft-revoke) under the org's RLS context; the
// consumption path (resolve + tail) is added in Slice C.

import {
  CapabilityFault,
  triggersCreate,
  triggersList,
  triggersRevoke,
  triggersWait,
} from "@webhook-co/contract";
import {
  decodeCursor,
  encodeCursor,
  MAX_INLINE_BODY_BYTES,
  newId,
  type AgentTriggerEvent,
  type BoundedPayloadBody,
  type Cursor,
  type EventSummary,
  type PayloadReaderRpc,
  type AuditActorInput,
} from "@webhook-co/shared";

import { requireAuditActor } from "./audit-actor-fault";
import { appendAuditEntry } from "./audit-append";
import { withTenant, type Sql } from "./client";
import { tailEventsWithCursors, type ItemWithCursor } from "./reads";
import { ensureScope, type CapabilityHandlers } from "./read-handlers";

/** Thrown by createAgentTrigger when the endpoint is missing / soft-deleted / cross-org. The cap handler
 *  maps it to NOT_FOUND — binding a trigger to a dead/foreign endpoint would be a rule that never fires,
 *  and a cross-org id must not leak existence. */
export class TriggerEndpointNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriggerEndpointNotFoundError";
  }
}

/** The management view of an agent trigger (mirrors AgentTriggerSchema in @webhook-co/shared). */
export interface AgentTriggerRecord {
  readonly id: string;
  readonly orgId: string;
  readonly endpointId: string;
  readonly name: string | null;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
}

interface AgentTriggerRow {
  id: string;
  org_id: string;
  endpoint_id: string;
  name: string | null;
  created_at: Date;
  revoked_at: Date | null;
}

const TRIGGER_COLS = "id, org_id, endpoint_id, name, created_at, revoked_at";

function toRecord(r: AgentTriggerRow): AgentTriggerRecord {
  return {
    id: r.id,
    orgId: r.org_id,
    endpointId: r.endpoint_id,
    name: r.name,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
  };
}

/** Optional tamper-evident audit context for a trigger mutation. */
export interface TriggerAudit {
  readonly auditKey: CryptoKey;
  readonly actor: AuditActorInput;
}

export interface CreateAgentTriggerInput {
  readonly orgId: string;
  readonly endpointId: string;
  /** Optional human/agent label. */
  readonly name?: string | null;
  /** Per-org active-trigger soft cap override (defaults to DEFAULT_MAX_TRIGGERS_PER_ORG). */
  readonly maxActive?: number;
}

/**
 * Per-org ACTIVE (non-revoked) agent-trigger soft cap — an abuse backstop that bounds both row growth and
 * the un-paginated triggers.list response. Exceeding it throws RATE_LIMITED (mirrors the endpoints soft
 * cap, ADR-0075). Best-effort (no advisory lock): a race admitting one extra active trigger is harmless.
 */
export const DEFAULT_MAX_TRIGGERS_PER_ORG = 100;

/**
 * Register a new agent trigger for (org, endpoint). The endpoint must be LIVE (not soft-deleted) and
 * same-org — a dead/cross-org endpoint throws {@link TriggerEndpointNotFoundError} (the cap maps it to
 * NOT_FOUND) rather than binding a trigger that could never fire. Multiple triggers may exist for one
 * endpoint (different agents / labels) — this always INSERTs a fresh row (no upsert). Appends an
 * `agent_trigger.created` audit entry when `audit` is supplied. Runs under the org's RLS context.
 */
export async function createAgentTrigger(
  app: Sql,
  input: CreateAgentTriggerInput,
  audit?: TriggerAudit,
): Promise<AgentTriggerRecord> {
  const id = newId();
  const name = input.name ?? null;
  return withTenant(app, input.orgId, async (tx) => {
    // RLS hides a cross-org endpoint (resolves to null too); deleted_at is null excludes soft-deleted.
    const [endpoint] = await tx<{ id: string }[]>`
      select id from endpoints where id = ${input.endpointId} and deleted_at is null`;
    if (endpoint === undefined) {
      throw new TriggerEndpointNotFoundError(
        `endpoint ${input.endpointId} not found, deleted, or cross-org`,
      );
    }
    // Per-org active-trigger soft cap (abuse backstop; bounds row growth + the list response). Counts the
    // org's own rows under RLS. RATE_LIMITED mirrors the endpoints soft cap taxonomy.
    const cap = input.maxActive ?? DEFAULT_MAX_TRIGGERS_PER_ORG;
    const [countRow] = await tx<{ count: number }[]>`
      select count(*)::int as count from agent_triggers where revoked_at is null`;
    if ((countRow?.count ?? 0) >= cap) {
      throw new CapabilityFault(
        "RATE_LIMITED",
        `active agent-trigger limit reached (${cap}); revoke unused triggers`,
      );
    }
    const [row] = await tx<AgentTriggerRow[]>`
      insert into agent_triggers (id, org_id, endpoint_id, name)
      values (${id}, ${input.orgId}, ${input.endpointId}, ${name})
      returning ${tx.unsafe(TRIGGER_COLS)}`;
    if (!row) throw new Error("createAgentTrigger: insert returned no row");
    if (audit) {
      await appendAuditEntry(tx, audit.auditKey, {
        orgId: input.orgId,
        actor: audit.actor,
        action: "agent_trigger.created",
        target: row.id,
      });
    }
    return toRecord(row);
  });
}

/** List an org's ACTIVE (non-revoked) triggers, optionally filtered to one endpoint, newest first, RLS. */
export async function listAgentTriggers(
  app: Sql,
  orgId: string,
  endpointId?: string,
): Promise<AgentTriggerRecord[]> {
  const rows = await withTenant(app, orgId, (tx) =>
    endpointId === undefined
      ? tx<AgentTriggerRow[]>`
          select ${tx.unsafe(TRIGGER_COLS)} from agent_triggers
          where revoked_at is null
          order by created_at desc, id desc`
      : tx<AgentTriggerRow[]>`
          select ${tx.unsafe(TRIGGER_COLS)} from agent_triggers
          where revoked_at is null and endpoint_id = ${endpointId}
          order by created_at desc, id desc`,
  );
  return rows.map(toRecord);
}

/**
 * Soft-revoke a trigger (set revoked_at) under the org's RLS context. IDEMPOTENT: returns `{ id }` when the
 * trigger exists in the caller's org — whether this call transitioned it (active → revoked) OR it was
 * already revoked by an earlier call — so a retried revoke after a lost response is a clean success, not a
 * spurious error. Returns null ONLY for an unknown / cross-org id (RLS hides it), which the cap maps to
 * NOT_FOUND (don't leak existence). The `agent_trigger.revoked` audit entry is appended ONLY on a real
 * transition (never on the already-revoked idempotent path), so a retry can't write a phantom audit row.
 */
export async function revokeAgentTrigger(
  app: Sql,
  orgId: string,
  id: string,
  audit?: TriggerAudit,
): Promise<{ readonly id: string } | null> {
  return withTenant(app, orgId, async (tx) => {
    const transitioned = await tx<{ id: string }[]>`
      update agent_triggers set revoked_at = now()
      where id = ${id} and revoked_at is null
      returning id`;
    if (transitioned.length > 0) {
      if (audit) {
        await appendAuditEntry(tx, audit.auditKey, {
          orgId,
          actor: audit.actor,
          action: "agent_trigger.revoked",
          target: id,
        });
      }
      return { id };
    }
    // No transition: either the row is already revoked (idempotent success, no re-audit) or it does not
    // exist for this org (unknown / cross-org → NOT_FOUND). One RLS-scoped existence probe distinguishes.
    const [exists] = await tx<{ id: string }[]>`select id from agent_triggers where id = ${id}`;
    return exists ? { id } : null;
  });
}

// ── The triggers.* capability handlers (S5) ────────────────────────────────────────────────────────
// Merged INTO the shared buildCapabilityHandlers map (see write-handlers.ts) so MCP auto-binds them — the
// inverse of subscriptions' dedicated off-map factory. Each handler enforces the cap scope FIRST (the sole
// authz gate on MCP), validates input, then mutates under RLS with an in-tx audit row.

/** Deps for the trigger handlers — no sealer (a trigger mints no secret). */
export interface TriggerHandlerDeps {
  /** webhook_app over the cache-disabled tenant binding — all mutations + the wait tail run here under RLS. */
  readonly tenant: Sql;
  /** Audit-chain HMAC key — signs the in-tx audit_log row on each mutation. */
  readonly auditKey: CryptoKey;
  /** HMAC key for the opaque resume cursors used by triggers.wait (import of CURSOR_KEY). */
  readonly cursorKey: CryptoKey;
  /** The engine's PayloadReader service binding — triggers.wait fetches the bounded inline body through it
   *  (the MCP worker has no R2). OPTIONAL: absent → triggers.wait returns summary-only (body null), which is
   *  also the graceful path in tests / on a surface without the binding. */
  readonly payloadReader?: PayloadReaderRpc;
}

/**
 * Project a scanned tail page into the events triggers.wait delivers (PURE). Two ADR-0103 rules:
 *   1. Drop `failed`-verification events entirely — a rejected signature is forged/tampered and must never
 *      be surfaced to an agent as a trigger.
 *   2. Stamp `vouched` = we authenticated the source (verified | authenticated); `unattempted` is forwarded
 *      with `vouched:false` (delivered, but explicitly not vouched-for).
 * The resume cursor is the LAST scanned item's cursor — good OR failed — so failed events are read exactly
 * once and the cursor never gets stuck on (or re-scans) them. `resumeCursor` is undefined only for an empty
 * page (caller keeps its prior cursor).
 */
export function projectTriggerPage(items: readonly ItemWithCursor<EventSummary>[]): {
  readonly events: AgentTriggerEvent[];
  readonly resumeCursor: Cursor | undefined;
} {
  const events: AgentTriggerEvent[] = [];
  let resumeCursor: Cursor | undefined;
  for (const { item, cursor } of items) {
    resumeCursor = cursor; // advance past EVERY scanned row (good or failed)
    const state = item.verificationState;
    if (state === "failed") continue; // never surface a checked-and-rejected (forged) event
    events.push({ ...item, vouched: state === "verified" || state === "authenticated" });
  }
  return { events, resumeCursor };
}

export function createAgentTriggerHandlers(deps: TriggerHandlerDeps): CapabilityHandlers {
  const handlers: CapabilityHandlers = new Map();

  handlers.set(triggersCreate.name, async (ctx, input) => {
    ensureScope(ctx, triggersCreate);
    const parsed = triggersCreate.input.safeParse(input);
    if (!parsed.success) {
      throw new CapabilityFault(
        "VALIDATION_ERROR",
        parsed.error.issues[0]?.message ?? "invalid input",
      );
    }
    try {
      return await createAgentTrigger(
        deps.tenant,
        { orgId: ctx.orgId, endpointId: parsed.data.endpointId, name: parsed.data.name ?? null },
        { auditKey: deps.auditKey, actor: requireAuditActor(ctx) },
      );
    } catch (err) {
      if (err instanceof TriggerEndpointNotFoundError) {
        throw new CapabilityFault("NOT_FOUND", "endpoint not found");
      }
      throw err;
    }
  });

  handlers.set(triggersList.name, async (ctx, input) => {
    ensureScope(ctx, triggersList);
    const parsed = triggersList.input.safeParse(input);
    if (!parsed.success)
      throw new CapabilityFault(
        "VALIDATION_ERROR",
        parsed.error.issues[0]?.message ?? "invalid input",
      );
    const items = await listAgentTriggers(deps.tenant, ctx.orgId, parsed.data.endpointId);
    return { items };
  });

  handlers.set(triggersRevoke.name, async (ctx, input) => {
    ensureScope(ctx, triggersRevoke);
    const parsed = triggersRevoke.input.safeParse(input);
    if (!parsed.success)
      throw new CapabilityFault(
        "VALIDATION_ERROR",
        parsed.error.issues[0]?.message ?? "invalid input",
      );
    const revoked = await revokeAgentTrigger(deps.tenant, ctx.orgId, parsed.data.triggerId, {
      auditKey: deps.auditKey,
      actor: requireAuditActor(ctx),
    });
    if (revoked === null) throw new CapabilityFault("NOT_FOUND", "trigger not found");
    return revoked;
  });

  // triggers.wait — the CONSUMPTION path (short-poll). Resolves the ACTIVE trigger to its endpoint under
  // RLS, then tails events past the cursor up to the gapless watermark, drops `failed` events (ADR-0103),
  // and returns { events, nextCursor, caughtUp }. Connection-safe: ONE fast withTenant scan per call (no
  // held connection, no server-side sleep) — the caller drives the poll cadence.
  handlers.set(triggersWait.name, async (ctx, input) => {
    ensureScope(ctx, triggersWait);
    const parsed = triggersWait.input.safeParse(input);
    if (!parsed.success) {
      throw new CapabilityFault(
        "VALIDATION_ERROR",
        parsed.error.issues[0]?.message ?? "invalid input",
      );
    }
    const { triggerId, cursor: cursorStr, limit, includeBody, maxBodyBytes } = parsed.data;
    let cursor: Cursor | undefined;
    // `!= null` treats an omitted OR null cursor the same — start from the oldest retained event. (A
    // caught-up page returns nextCursor:null; the caller passes it straight back per the tool contract.)
    if (cursorStr != null) {
      try {
        cursor = await decodeCursor(cursorStr, deps.cursorKey);
      } catch {
        throw new CapabilityFault("VALIDATION_ERROR", "invalid cursor");
      }
    }
    const result = await withTenant(deps.tenant, ctx.orgId, async (tx) => {
      // Resolve the trigger under RLS — an unknown / revoked / cross-org id is NOT_FOUND (no existence
      // oracle). The endpoint comes from the RLS-resolved row, NEVER from client input; the composite FK
      // guarantees it is same-org, so the subsequent tail can only ever read this org's events.
      const [trig] = await tx<{ endpoint_id: string }[]>`
        select endpoint_id from agent_triggers where id = ${triggerId} and revoked_at is null`;
      if (trig === undefined) throw new CapabilityFault("NOT_FOUND", "trigger not found");
      const endpointId = trig.endpoint_id;
      // NOTE: retention is INFINITE today (no prune/TTL job), so a resume cursor can never point below the
      // oldest surviving event — the CURSOR_EXPIRED guard (cursorBelowOldest, packages/db/src/reads.ts)
      // cannot fire yet, so it is deliberately NOT called on this hot poll path (it would add a min()
      // aggregate scan per poll for a throw that can't happen). WHEN a retention/TTL job is added, wire
      // cursorBelowOldest here (→ VALIDATION_ERROR "cursor expired") so a pruned-gap fails loud instead of
      // silently resuming from the oldest survivor. The function + its tests already exist for that.
      const page = await tailEventsWithCursors(tx, { endpointId, sinceCursor: cursor, limit });
      const { events, resumeCursor } = projectTriggerPage(page.items);
      const nextCursor =
        resumeCursor !== undefined
          ? await encodeCursor(resumeCursor, deps.cursorKey)
          : (cursorStr ?? null);
      // caughtUp = this page reached the watermark head (no lookahead row) — the caller can back off.
      return { events, nextCursor, caughtUp: page.nextCursor === null };
    });

    // Attach the bounded inline body to each event via the engine's org-scoped PayloadReader RPC (a separate
    // call — the MCP worker has no R2 binding). Runs AFTER the tenant tx closes. Skipped (body-less) when the
    // caller passes includeBody:false, there are no events, or no binding is wired (tests / body-less surface).
    const wantBody =
      (includeBody ?? true) && deps.payloadReader !== undefined && result.events.length > 0;
    if (!wantBody) return result;
    // GRACEFUL DEGRADATION: the inline body is best-effort. The tail read already succeeded, so a transient
    // engine/R2 failure (a thrown RPC, a rolling-deploy skew where PayloadReader is momentarily down) must
    // NOT fail the whole poll — that would stall the agent's ack cursor. On any RPC error we fall back to
    // summary-only (every body null); the agent still consumes its events and advances.
    let bodyById = new Map<string, BoundedPayloadBody>();
    try {
      const bodies = await deps.payloadReader!.readBoundedBodies({
        orgId: ctx.orgId,
        eventIds: result.events.map((e) => e.id),
        maxBytesEach: maxBodyBytes ?? MAX_INLINE_BODY_BYTES,
      });
      bodyById = new Map(bodies.map((b) => [b.eventId, b]));
    } catch {
      // fall through with an empty map → every event degrades to body:null below.
    }
    return {
      ...result,
      // ONE event shape across the whole page: a body-absent event still carries bodyEncoding + contentType
      // (nulled), exactly like a found event, so a consumer never sees fields flicker in/out within a page.
      events: result.events.map((e) => {
        const b = bodyById.get(e.id);
        return b?.found
          ? {
              ...e,
              body: b.body,
              bodyEncoding: b.encoding,
              bodyTruncated: b.truncated,
              contentType: b.contentType,
            }
          : {
              ...e,
              body: null,
              bodyEncoding: "utf8" as const,
              bodyTruncated: false,
              contentType: null,
            };
      }),
    };
  });

  return handlers;
}
