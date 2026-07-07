import "server-only";

import { listAgentTriggers, type AgentTriggerRecord } from "@webhook-co/db/agent-triggers";
import type { Sql } from "@webhook-co/db/client";

import { logActionError } from "./action-log";
import { withTenantDb } from "./db";

// The agent-triggers read surface for the dashboard (triggers.list). An agent trigger is an org-scoped
// (endpoint) subscription that wakes an MCP agent when the endpoint captures a new event (S5). Read live via
// the Lane fn under withTenant(orgId) as webhook_app; RLS (the session orgId) is the tenant backstop, so a
// cross-org row simply isn't visible. The record carries orgId (an internal pointer) — the browser-safe item
// strips it. The consumption tool (triggers.wait) is NOT a web surface: the dashboard already streams live
// events over its own WebSocket, so this view is management-only (list / create / revoke).

/** A trigger row for the dashboard — the db record minus the internal `orgId`. */
export type TriggerItem = Omit<AgentTriggerRecord, "orgId">;

export type TriggersResult =
  { readonly status: "ok"; readonly items: readonly TriggerItem[] } | { readonly status: "error" };

/** The reads this surface needs, injectable for tests; the default binds the per-request tenant pool. */
export interface TriggerReaders {
  list(orgId: string): Promise<AgentTriggerRecord[]>;
}

function boundReaders(app: Sql): TriggerReaders {
  return {
    list: (orgId) => listAgentTriggers(app, orgId),
  };
}

/** Strip the internal orgId pointer; everything else is safe to render. Shared by the loader + actions. */
export function toTriggerItem(r: AgentTriggerRecord): TriggerItem {
  const { orgId: _orgId, ...rest } = r;
  return rest;
}

/**
 * Load the org's active agent triggers (newest-first, whole set — the list is a managed handful, so it is
 * intentionally un-paginated, matching the api/cli/mcp `triggers.list`). A db fault reads as
 * `{status:"error"}` (logged, scrubbed). Tests inject `readers` and skip the pool.
 */
export async function loadTriggers(
  orgId: string,
  readers?: TriggerReaders,
): Promise<TriggersResult> {
  const load = (r: TriggerReaders) =>
    r.list(orgId).then((rows) => ({ status: "ok" as const, items: rows.map(toTriggerItem) }));
  try {
    if (readers) return await load(readers);
    return await withTenantDb((app) => load(boundReaders(app)));
  } catch (error) {
    logActionError("triggers.load", error);
    return { status: "error" };
  }
}
