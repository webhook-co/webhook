// The shared capability READ handlers — the single place the read capabilities' logic lives,
// bound identically by apps/api (HTTP) and apps/mcp (MCP tools). Each handler enforces the
// capability's scope, validates input against the contract Zod schema, runs the tenant read
// under RLS, and returns the contract-shaped output. Every failure is a typed CapabilityFault
// (FORBIDDEN / VALIDATION_ERROR / NOT_FOUND) the surface maps to its transport — so the two
// surfaces can never drift, and the read logic is tested once (the db pool).

import {
  CapabilityFault,
  auditVerify,
  deliveriesGet,
  deliveriesList,
  endpointsGet,
  endpointsList,
  eventsGet,
  eventsList,
  eventsTail,
  usageGet,
  type AnyCapability,
  type AuthContext,
} from "@webhook-co/contract";
import {
  decodeCursor,
  encodeCursor,
  orderKeyLagMs,
  parseSince,
  type Cursor,
  type DedupStrategy,
  type Since,
  type VerificationState,
  type PayloadReaderRpc,
} from "@webhook-co/shared";

import { verifyAuditChainPaged } from "./audit-append";
import { withTenant, type Sql } from "./client";
import {
  getDelivery,
  getEndpoint,
  getEvent,
  latestTailCursor,
  listDeliveries,
  listEndpoints,
  listEvents,
  listOrgEvents,
  readUsageSummary,
  resolveSince,
  tailEvents,
  tailMeta,
} from "./reads";

// Normalize a multiEnum filter value (scalar | array | undefined) to an array | undefined — the contract
// accepts a scalar for backward-compat but can't transform-normalize it (JSON-Schema constraint).
function asArray<T>(value: T | T[] | undefined): T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

export interface ReadHandlerDeps {
  /** webhook_app over the cache-disabled tenant binding — tenant reads run here. */
  readonly tenant: Sql;
  /** HMAC key for opaque pagination cursors (import of CURSOR_KEY). */
  readonly cursorKey: CryptoKey;
  /** Audit-chain HMAC key (import of AUDIT_CHAIN_HMAC_KEY) for audit.verify. */
  readonly auditKey: CryptoKey;
  /** Engine PayloadReader RPC (S5 C2) — triggers.wait fetches the bounded inline body through it. Optional:
   *  absent → triggers.wait returns summary-only (body null). Threaded to createAgentTriggerHandlers. */
  readonly payloadReader?: PayloadReaderRpc;
  /** The injected Free-tier default event cap (FREE_EVENT_CAP) for usage.get on a rowless org — the SAME
   *  value the engine cap producer enforces at, so the surface shows the real cap not "uncapped" (S4.3b).
   *  Optional; absent/null → uncapped (unset = no Free enforcement, the fail-safe default). */
  readonly defaultEventCap?: number | null;
}

// A bound capability handler — the shared shape for BOTH reads (createReadHandlers) and writes
// (createWriteHandlers). Named for the capability, not the verb: api/mcp merge the read + write maps
// into one and dispatch by name, so a single type spans both. (Was ReadHandler; renamed when the first
// write capability — endpoints.create — joined the map.)
export type CapabilityHandler = (ctx: AuthContext, input: unknown) => Promise<unknown>;
export type CapabilityHandlers = Map<string, CapabilityHandler>;

/**
 * Enforce a capability's required scope FIRST in every handler (read/write/replay-destinations/subscriptions
 * share this one definition). On the api edge `authorizeBearer` already gates the scope before dispatch, but
 * on mcp (where the shared read+write map is the SOLE authz gate) this in-handler check is load-bearing —
 * so it is invoked before any mutation/read in each handler.
 */
export function ensureScope(ctx: AuthContext, cap: AnyCapability): void {
  if (!ctx.scopes.includes(cap.auth.scope)) {
    throw new CapabilityFault("FORBIDDEN", `missing required scope: ${cap.auth.scope}`);
  }
}

/**
 * Coerce an optional received-at bound string to a Date via the lenient `new Date` parse — the ONE place
 * both bounds resolve a plain instant, so receivedAfter and receivedBefore stay in lock-step by construction.
 *
 * "Lenient" is JS `Date`'s leniency, unchanged and shared: a date-only `2026-07-01`, a no-timezone
 * `...T00:00:00`, and even a calendar overflow like `2026-06-31` (→ Jul 1) all resolve — exactly as
 * receivedBefore has always done and receivedAfter did before durations were added. It is deliberately MORE
 * lenient than events.tail's strict `since` grammar; these are fuzzy browse bounds, not a gapless cursor.
 * Absent OR empty → no bound (undefined): empty means "no filter", and only MCP can send it (the HTTP route
 * drops empties) — treating it symmetrically avoids a 400 on one bound but not the other.
 */
export function toInstantBound(
  value: string | undefined,
  label = "received-at bound",
): Date | undefined {
  if (value === undefined || value === "") return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new CapabilityFault("VALIDATION_ERROR", `invalid ${label}`);
  }
  return d;
}

/**
 * Resolve the `receivedAfter` lower bound. This capability ADDS the `--since` relative grammar (`beginning` |
 * `<duration>` like `7d`/`30m`) on TOP of everything the plain instant bound (`toInstantBound`) accepts — the
 * same "last N" vocabulary the web presets use, now on api/mcp/cli too. New here, not pre-existing prior art:
 * before this change the server resolved receivedAfter via the strict instant parse, so `--after 7d` 400'd.
 *
 * A strict SUPERSET of `toInstantBound`, by construction: parseSince recognises the relative grammar; anything
 * it doesn't (a plain instant, incl. the lenient forms parseSince rejects but `new Date` accepts — date-only,
 * no-tz, even a calendar overflow) falls straight through to `toInstantBound`. So receivedAfter accepts every
 * instant receivedBefore does, plus durations — never fewer, never asymmetric. Only a value neither can read
 * is a 400.
 *
 * `now` is accepted (grammar parity with events.tail) but deliberately NOT advertised for receivedAfter: on a
 * newest-first browse `received_at >= now()` is a no-op (empty page). Relative durations resolve against the
 * SERVER clock — a fuzzy browse bound, not the tail's gapless watermark, so no clock-skew guarantee is owed.
 * `beginning` = no lower bound (undefined).
 */
export function resolveReceivedAfter(value: string | undefined): Date | undefined {
  const since =
    value === undefined || value === "" ? { kind: "beginning" as const } : parseSince(value);
  switch (since.kind) {
    case "beginning":
      return undefined;
    case "now":
      return new Date();
    case "relative":
      return new Date(Date.now() - since.ms);
    case "timestamp":
      return since.date;
    case "invalid":
      // Not the relative grammar — resolve it as a plain instant, exactly as (and via the same helper as)
      // receivedBefore, so the two bounds can never diverge on a shared string. Same throw for true garbage.
      return toInstantBound(value, "receivedAfter (expected an instant or a duration like 7d)");
  }
}

export function createReadHandlers(deps: ReadHandlerDeps): CapabilityHandlers {
  function parse<C extends AnyCapability>(cap: C, input: unknown): unknown {
    const result = cap.input.safeParse(input);
    if (!result.success) throw new CapabilityFault("VALIDATION_ERROR", "invalid input");
    return result.data;
  }

  async function decode(cursor: string | undefined): Promise<Cursor | undefined> {
    if (cursor === undefined) return undefined;
    try {
      return await decodeCursor(cursor, deps.cursorKey);
    } catch {
      throw new CapabilityFault("VALIDATION_ERROR", "invalid cursor");
    }
  }

  function encode(cursor: Cursor | null): Promise<string> | null {
    return cursor ? encodeCursor(cursor, deps.cursorKey) : null;
  }

  const handlers: CapabilityHandlers = new Map();

  handlers.set(endpointsList.name, async (ctx, input) => {
    ensureScope(ctx, endpointsList);
    const { cursor, limit, filter } = parse(endpointsList, input) as {
      cursor?: string;
      limit?: number;
      filter?: { name?: string };
    };
    const decoded = await decode(cursor);
    const page = await withTenant(deps.tenant, ctx.orgId, (tx) =>
      listEndpoints(tx, { cursor: decoded, limit, name: filter?.name }),
    );
    return { items: page.items, nextCursor: await encode(page.nextCursor) };
  });

  handlers.set(endpointsGet.name, async (ctx, input) => {
    ensureScope(ctx, endpointsGet);
    const { endpointId } = parse(endpointsGet, input) as { endpointId: string };
    const endpoint = await withTenant(deps.tenant, ctx.orgId, (tx) => getEndpoint(tx, endpointId));
    if (!endpoint) throw new CapabilityFault("NOT_FOUND", "endpoint not found");
    return endpoint;
  });

  handlers.set(eventsList.name, async (ctx, input) => {
    ensureScope(ctx, eventsList);
    const { endpointId, cursor, limit, filter } = parse(eventsList, input) as {
      // OPTIONAL: absent = org-wide (every endpoint in the org, RLS-scoped); present = drill down to one.
      endpointId?: string;
      cursor?: string;
      limit?: number;
      filter?: {
        // multiEnum accepts a scalar OR an array (the contract can't transform-normalize without breaking
        // the MCP inputSchema), so normalize to an array here.
        provider?: string | string[];
        receivedAfter?: string;
        receivedBefore?: string;
        verificationState?: VerificationState | VerificationState[];
        search?: string;
        dedupStrategy?: string | string[];
        method?: string | string[];
        eventType?: string;
      };
    };
    const provider = asArray(filter?.provider);
    const verificationState = asArray(filter?.verificationState);
    // The range bounds arrive as RFC3339 strings (the contract input is a plain string so the MCP tool
    // inputSchema stays JSON-Schema-clean); validate + coerce them to Dates HERE — a malformed bound is
    // a VALIDATION_ERROR, never a raw string handed to SQL.
    const receivedAfter = resolveReceivedAfter(filter?.receivedAfter);
    const receivedBefore = toInstantBound(filter?.receivedBefore, "receivedBefore");
    const decoded = await decode(cursor);
    // The filter half of the browse is identical org-wide vs endpoint-scoped; only endpointId + the
    // existence gate + the (endpoint-only) headCursor differ.
    const browseFilters = {
      cursor: decoded,
      limit,
      provider,
      receivedAfter,
      receivedBefore,
      verificationState,
      search: filter?.search,
      // A typed cast, NOT `as never`: the value is contract-validated to the DedupStrategy enum, and this
      // keeps that contract legible instead of silencing the checker (which would also mask a real
      // regression if the contract validation were ever dropped). The security review flagged the smell.
      dedupStrategy: asArray(filter?.dedupStrategy) as DedupStrategy[] | undefined,
      method: asArray(filter?.method),
      eventType: filter?.eventType,
    };
    const { page, headCursor } = await withTenant(deps.tenant, ctx.orgId, async (tx) => {
      if (endpointId === undefined) {
        // ORG-WIDE browse: no endpoint to gate on, so no existence check (RLS supplies the org boundary),
        // and NO headCursor — it's the resume position for the endpoint-scoped events.tail, meaningless
        // for an org-wide feed (the contract already declares headCursor optional).
        return { page: await listOrgEvents(tx, browseFilters), headCursor: null };
      }
      // ENDPOINT drill-down. Distinguish "no such endpoint for this org" (NOT_FOUND) from "endpoint with no
      // events". includeDeleted (ADR-0076): a soft-deleted endpoint's captured events are RETAINED + stay
      // listable by id — so the existence gate resolves a deleted endpoint (endpoints.list hides it).
      const endpoint = await getEndpoint(tx, endpointId, { includeDeleted: true });
      if (!endpoint) throw new CapabilityFault("NOT_FOUND", "endpoint not found");
      const browsed = await listEvents(tx, { endpointId, ...browseFilters });
      // A newest-first browse; surface the watermark-bounded head as a resumable checkpoint (caughtUp/lag
      // are forward-tail concepts and don't apply to a DESC browse).
      return { page: browsed, headCursor: await latestTailCursor(tx, { endpointId }) };
    });
    return {
      items: page.items,
      nextCursor: await encode(page.nextCursor),
      headCursor: await encode(headCursor),
    };
  });

  handlers.set(eventsTail.name, async (ctx, input) => {
    ensureScope(ctx, eventsTail);
    const { endpointId, sinceCursor, since } = parse(eventsTail, input) as {
      endpointId: string;
      sinceCursor?: string;
      since?: string;
    };
    // `since` (a server-resolved grammar) and `sinceCursor` (an opaque resume cursor) are mutually
    // exclusive — a caller passes one or neither (mirrors the engine /listen exclusivity).
    if (since !== undefined && sinceCursor !== undefined) {
      throw new CapabilityFault("VALIDATION_ERROR", "since and sinceCursor are mutually exclusive");
    }
    let parsedSince: Exclude<Since, { kind: "invalid" }> | undefined;
    if (since !== undefined) {
      const p = parseSince(since);
      if (p.kind === "invalid") {
        throw new CapabilityFault("VALIDATION_ERROR", `invalid since: ${p.reason}`);
      }
      parsedSince = p;
    }
    const decoded = await decode(sinceCursor);
    const { page, meta } = await withTenant(deps.tenant, ctx.orgId, async (tx) => {
      // Same NOT_FOUND-vs-empty distinction as events.list. tailEvents computes the gapless watermark
      // cutoff (now() - δ) Postgres-side, so a slow caller can't pin an old cutoff and there's no
      // Worker↔Postgres clock skew in the gapless invariant. tailMeta reuses that exact window for the
      // head + the (capped) backlog count, in the same RLS-scoped tx.
      // includeDeleted (ADR-0076): a soft-deleted endpoint's captured events stay tailable by id.
      const endpoint = await getEndpoint(tx, endpointId, { includeDeleted: true });
      if (!endpoint) throw new CapabilityFault("NOT_FOUND", "endpoint not found");
      // Resolve `--since` to a cursor ONCE (after the guard, under RLS), then iterate by it.
      const from = parsedSince
        ? await resolveSince(tx, { endpointId, since: parsedSince })
        : decoded;
      const tailed = await tailEvents(tx, { endpointId, sinceCursor: from });
      return { page: tailed, meta: await tailMeta(tx, { endpointId, sinceCursor: from }) };
    });
    // headLagMs is advisory (Worker clock vs the DB-stamped head; floored by the 5s watermark anyway).
    // Shared with the tunnel status frame via orderKeyLagMs so the two surfaces can't drift on the math.
    const headLagMs =
      meta.headCursor === null ? undefined : orderKeyLagMs(meta.headCursor.orderKey, Date.now());
    return {
      items: page.items,
      nextCursor: await encode(page.nextCursor),
      headCursor: await encode(meta.headCursor),
      // caughtUp = this page reached the end of the watermark-bounded tail (no more pages).
      caughtUp: page.nextCursor === null,
      lag: {
        backlogCount: meta.backlogCount,
        ...(headLagMs !== undefined ? { headLagMs } : {}),
      },
    };
  });

  handlers.set(eventsGet.name, async (ctx, input) => {
    ensureScope(ctx, eventsGet);
    const { eventId } = parse(eventsGet, input) as { eventId: string };
    const event = await withTenant(deps.tenant, ctx.orgId, (tx) => getEvent(tx, eventId));
    if (!event) throw new CapabilityFault("NOT_FOUND", "event not found");
    return event;
  });

  // Deliveries — the auto-delivery observability reads (S3 Slice 3 PR3). Shared map ⇒ api + mcp parity.
  handlers.set(deliveriesList.name, async (ctx, input) => {
    ensureScope(ctx, deliveriesList);
    const { destinationId, subscriptionId, status, cursor, limit } = parse(
      deliveriesList,
      input,
    ) as {
      destinationId?: string;
      subscriptionId?: string;
      // multiEnum: a scalar OR an array (the contract can't transform-normalize) → normalized here.
      status?: string | string[];
      cursor?: string;
      limit?: number;
    };
    const decoded = await decode(cursor);
    const page = await withTenant(deps.tenant, ctx.orgId, (tx) =>
      listDeliveries(tx, {
        destinationId,
        subscriptionId,
        status: asArray(status),
        cursor: decoded,
        limit,
      }),
    );
    return { items: page.items, nextCursor: await encode(page.nextCursor) };
  });

  handlers.set(deliveriesGet.name, async (ctx, input) => {
    ensureScope(ctx, deliveriesGet);
    const { deliveryId } = parse(deliveriesGet, input) as { deliveryId: string };
    const delivery = await withTenant(deps.tenant, ctx.orgId, (tx) => getDelivery(tx, deliveryId));
    if (!delivery) throw new CapabilityFault("NOT_FOUND", "delivery not found");
    return delivery;
  });

  handlers.set(auditVerify.name, async (ctx, input) => {
    ensureScope(ctx, auditVerify);
    parse(auditVerify, input); // input is {} — validate it's shaped right
    // Stream the chain page-by-page (#636) — the whole chain in memory is a Worker OOM risk that grows with
    // org age. verifyAuditChainPaged carries the prior page's tail so every hash-chain check still holds.
    return withTenant(deps.tenant, ctx.orgId, (tx) =>
      verifyAuditChainPaged(tx, ctx.orgId, deps.auditKey),
    );
  });

  // usage.get (S4.2): the metering usage surface for the caller's org + current billing period. Empty
  // input; RLS scopes the reads to the org. Now() is the wall clock (the period is the UTC month until
  // Stripe anchors it in S4.4).
  handlers.set(usageGet.name, async (ctx, input) => {
    ensureScope(ctx, usageGet);
    parse(usageGet, input); // input is {} — validate shape
    return withTenant(deps.tenant, ctx.orgId, (tx) =>
      readUsageSummary(tx, Date.now(), deps.defaultEventCap ?? null),
    );
  });

  return handlers;
}
