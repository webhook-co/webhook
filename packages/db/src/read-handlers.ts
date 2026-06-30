// The shared capability READ handlers — the single place the read capabilities' logic lives,
// bound identically by apps/api (HTTP) and apps/mcp (MCP tools). Each handler enforces the
// capability's scope, validates input against the contract Zod schema, runs the tenant read
// under RLS, and returns the contract-shaped output. Every failure is a typed CapabilityFault
// (FORBIDDEN / VALIDATION_ERROR / NOT_FOUND) the surface maps to its transport — so the two
// surfaces can never drift, and the read logic is tested once (the db pool).

import {
  CapabilityFault,
  auditVerify,
  endpointsGet,
  endpointsList,
  eventsGet,
  eventsList,
  eventsTail,
  type AnyCapability,
  type AuthContext,
} from "@webhook-co/contract";
import {
  decodeCursor,
  encodeCursor,
  parseSince,
  verifyAuditChain,
  type Cursor,
  type Since,
  type VerificationState,
} from "@webhook-co/shared";

import { readAuditChain } from "./audit-append";
import { withTenant, type Sql } from "./client";
import {
  getEndpoint,
  getEvent,
  latestTailCursor,
  listEndpoints,
  listEvents,
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
}

// A bound capability handler — the shared shape for BOTH reads (createReadHandlers) and writes
// (createWriteHandlers). Named for the capability, not the verb: api/mcp merge the read + write maps
// into one and dispatch by name, so a single type spans both. (Was ReadHandler; renamed when the first
// write capability — endpoints.create — joined the map.)
export type CapabilityHandler = (ctx: AuthContext, input: unknown) => Promise<unknown>;
export type CapabilityHandlers = Map<string, CapabilityHandler>;

/** Coerce an optional RFC3339 received-at bound (string) to a Date; a malformed value → VALIDATION_ERROR. */
function toInstantBound(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new CapabilityFault("VALIDATION_ERROR", "invalid received-at bound");
  }
  return d;
}

export function createReadHandlers(deps: ReadHandlerDeps): CapabilityHandlers {
  function ensureScope(ctx: AuthContext, cap: AnyCapability): void {
    if (!ctx.scopes.includes(cap.auth.scope)) {
      throw new CapabilityFault("FORBIDDEN", `missing required scope: ${cap.auth.scope}`);
    }
  }

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
      endpointId: string;
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
      };
    };
    const provider = asArray(filter?.provider);
    const verificationState = asArray(filter?.verificationState);
    // The range bounds arrive as RFC3339 strings (the contract input is a plain string so the MCP tool
    // inputSchema stays JSON-Schema-clean); validate + coerce them to Dates HERE — a malformed bound is
    // a VALIDATION_ERROR, never a raw string handed to SQL.
    const receivedAfter = toInstantBound(filter?.receivedAfter);
    const receivedBefore = toInstantBound(filter?.receivedBefore);
    const decoded = await decode(cursor);
    const { page, headCursor } = await withTenant(deps.tenant, ctx.orgId, async (tx) => {
      // Distinguish "no such endpoint for this org" (NOT_FOUND) from "endpoint with no events".
      // includeDeleted (ADR-0076): a soft-deleted endpoint's captured events are RETAINED + stay
      // listable by id — so the existence gate resolves a deleted endpoint (endpoints.list hides it).
      const endpoint = await getEndpoint(tx, endpointId, { includeDeleted: true });
      if (!endpoint) throw new CapabilityFault("NOT_FOUND", "endpoint not found");
      const browsed = await listEvents(tx, {
        endpointId,
        cursor: decoded,
        limit,
        provider,
        receivedAfter,
        receivedBefore,
        verificationState,
        search: filter?.search,
      });
      // events.list is a newest-first browse; surface the watermark-bounded head as a resumable
      // checkpoint (caughtUp/lag are forward-tail concepts and don't apply to a DESC browse).
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
    const headLagMs =
      meta.headCursor === null
        ? undefined
        : Math.max(0, Date.now() - meta.headCursor.receivedAt.getTime());
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

  handlers.set(auditVerify.name, async (ctx, input) => {
    ensureScope(ctx, auditVerify);
    parse(auditVerify, input); // input is {} — validate it's shaped right
    const rows = await withTenant(deps.tenant, ctx.orgId, (tx) => readAuditChain(tx, ctx.orgId));
    return verifyAuditChain(deps.auditKey, ctx.orgId, rows);
  });

  return handlers;
}
