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
import { decodeCursor, encodeCursor, verifyAuditChain, type Cursor } from "@webhook-co/shared";

import { readAuditChain } from "./audit-append";
import { withTenant, type Sql } from "./client";
import {
  getEndpoint,
  getEvent,
  latestTailCursor,
  listEndpoints,
  listEvents,
  tailEvents,
  tailMeta,
} from "./reads";

export interface ReadHandlerDeps {
  /** webhook_app over the cache-disabled tenant binding — tenant reads run here. */
  readonly tenant: Sql;
  /** HMAC key for opaque pagination cursors (import of CURSOR_KEY). */
  readonly cursorKey: CryptoKey;
  /** Audit-chain HMAC key (import of AUDIT_CHAIN_HMAC_KEY) for audit.verify. */
  readonly auditKey: CryptoKey;
}

export type ReadHandler = (ctx: AuthContext, input: unknown) => Promise<unknown>;
export type ReadHandlers = Map<string, ReadHandler>;

export function createReadHandlers(deps: ReadHandlerDeps): ReadHandlers {
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

  const handlers: ReadHandlers = new Map();

  handlers.set(endpointsList.name, async (ctx, input) => {
    ensureScope(ctx, endpointsList);
    const { cursor, limit } = parse(endpointsList, input) as { cursor?: string; limit?: number };
    const decoded = await decode(cursor);
    const page = await withTenant(deps.tenant, ctx.orgId, (tx) =>
      listEndpoints(tx, { cursor: decoded, limit }),
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
      filter?: { provider: string };
    };
    const decoded = await decode(cursor);
    const { page, headCursor } = await withTenant(deps.tenant, ctx.orgId, async (tx) => {
      // Distinguish "no such endpoint for this org" (NOT_FOUND) from "endpoint with no events".
      const endpoint = await getEndpoint(tx, endpointId);
      if (!endpoint) throw new CapabilityFault("NOT_FOUND", "endpoint not found");
      const browsed = await listEvents(tx, {
        endpointId,
        cursor: decoded,
        limit,
        provider: filter?.provider,
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
    const { endpointId, sinceCursor } = parse(eventsTail, input) as {
      endpointId: string;
      sinceCursor?: string;
    };
    const decoded = await decode(sinceCursor);
    const { page, meta } = await withTenant(deps.tenant, ctx.orgId, async (tx) => {
      // Same NOT_FOUND-vs-empty distinction as events.list. tailEvents computes the gapless watermark
      // cutoff (now() - δ) Postgres-side, so a slow caller can't pin an old cutoff and there's no
      // Worker↔Postgres clock skew in the gapless invariant. tailMeta reuses that exact window for the
      // head + the (capped) backlog count, in the same RLS-scoped tx.
      const endpoint = await getEndpoint(tx, endpointId);
      if (!endpoint) throw new CapabilityFault("NOT_FOUND", "endpoint not found");
      const tailed = await tailEvents(tx, { endpointId, sinceCursor: decoded });
      return { page: tailed, meta: await tailMeta(tx, { endpointId, sinceCursor: decoded }) };
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
