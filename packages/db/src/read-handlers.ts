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
  type AnyCapability,
  type AuthContext,
} from "@webhook-co/contract";
import { decodeCursor, encodeCursor, verifyAuditChain, type Cursor } from "@webhook-co/shared";

import { readAuditChain } from "./audit-append";
import { withTenant, type Sql } from "./client";
import { getEndpoint, getEvent, listEndpoints, listEvents } from "./reads";

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
    const page = await withTenant(deps.tenant, ctx.orgId, async (tx) => {
      // Distinguish "no such endpoint for this org" (NOT_FOUND) from "endpoint with no events".
      const endpoint = await getEndpoint(tx, endpointId);
      if (!endpoint) throw new CapabilityFault("NOT_FOUND", "endpoint not found");
      return listEvents(tx, { endpointId, cursor: decoded, limit, provider: filter?.provider });
    });
    return { items: page.items, nextCursor: await encode(page.nextCursor) };
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
