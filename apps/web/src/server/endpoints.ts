import "server-only";

import { withTenant, type Sql } from "@webhook-co/db/client";
import { DEFAULT_MAX_ENDPOINTS_PER_ORG } from "@webhook-co/db/endpoints";
import { getEndpoint, listEndpoints } from "@webhook-co/db/reads";
import type { Cursor, Endpoint } from "@webhook-co/shared";

import { getTenantDb } from "./db";

// The endpoint display shape for the dashboard. Mirrors the db `Endpoint` entity MINUS orgId — no token,
// hash, or org identifier crosses to the browser (private-by-default; the plaintext is shown ONCE at
// create/rotate and never stored). Read live via the Lane reads under withTenant(orgId) as webhook_app;
// RLS (the session orgId) is the tenant backstop, so these queries never filter by org_id themselves and a
// cross-org id simply isn't visible.

export interface EndpointItem {
  readonly id: string;
  readonly name: string;
  readonly paused: boolean;
  readonly createdAt: Date;
}

export type EndpointsResult =
  | { readonly status: "ok"; readonly endpoints: readonly EndpointItem[] }
  | { readonly status: "error" };

export type EndpointResult =
  | { readonly status: "ok"; readonly endpoint: EndpointItem }
  | { readonly status: "not_found" }
  | { readonly status: "error" };

/** The reads this surface needs, injectable for tests; the default binds the per-request tenant tx. */
export interface EndpointReaders {
  listEndpoints(orgId: string): Promise<readonly EndpointItem[]>;
  getEndpoint(orgId: string, id: string): Promise<EndpointItem | null>;
}

// The id path segment must be a uuid (the endpoints.id column is uuid); a non-uuid can never name an
// endpoint, so callers treat it as not-found (→ 404 on the read, a clean error on a mutation) rather than
// letting Postgres raise 22P02 and surfacing a misleading "try again" error the user can never recover.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Project the db `Endpoint` to the browser-safe `EndpointItem` (drops orgId — never serialized to props). */
function toItem(e: Endpoint): EndpointItem {
  return { id: e.id, name: e.name, paused: e.paused, createdAt: e.createdAt };
}

interface ItemPage {
  readonly items: readonly EndpointItem[];
  readonly nextCursor: Cursor | null;
}

/**
 * Collect EVERY page of a keyset-paginated endpoint list into one array. Exported + pure (takes a
 * page-fetcher) so the "show ALL live endpoints, not just the first page" guarantee has a regression test
 * without a DB. The default fetcher requests DEFAULT_MAX_ENDPOINTS_PER_ORG rows (= the per-org cap, so it
 * asks for cap+1 internally and a healthy org returns everything in ONE round trip); the loop is the
 * impossible-overflow safety net so a future cap raise can never silently truncate the dashboard list.
 */
export async function collectAllEndpoints(
  fetchPage: (cursor?: Cursor) => Promise<ItemPage>,
): Promise<EndpointItem[]> {
  const items: EndpointItem[] = [];
  let page = await fetchPage();
  items.push(...page.items);
  while (page.nextCursor) {
    page = await fetchPage(page.nextCursor);
    items.push(...page.items);
  }
  return items;
}

function boundReaders(app: Sql): EndpointReaders {
  return {
    listEndpoints: (orgId) =>
      withTenant(app, orgId, (tx) =>
        collectAllEndpoints(async (cursor) => {
          const page = await listEndpoints(tx, { cursor, limit: DEFAULT_MAX_ENDPOINTS_PER_ORG });
          return { items: page.items.map(toItem), nextCursor: page.nextCursor };
        }),
      ),
    getEndpoint: (orgId, id) =>
      withTenant(app, orgId, async (tx) => {
        const e = await getEndpoint(tx, id);
        return e ? toItem(e) : null;
      }),
  };
}

/**
 * Load the org's endpoints for the dashboard list. A db/Hyperdrive fault surfaces as `{status:"error"}`
 * (the view shows the error state) rather than throwing. Owns the per-request DB pool and releases it
 * (mirrors apps/api's teardown) so connections don't leak. Tests inject `readers` and skip the pool.
 */
export async function loadEndpoints(
  orgId: string,
  readers?: EndpointReaders,
): Promise<EndpointsResult> {
  if (readers) return readEndpoints(orgId, readers);
  const app = await getTenantDb();
  try {
    return await readEndpoints(orgId, boundReaders(app));
  } finally {
    await app.end({ timeout: 5 }).catch(() => {});
  }
}

async function readEndpoints(orgId: string, r: EndpointReaders): Promise<EndpointsResult> {
  try {
    return { status: "ok", endpoints: await r.listEndpoints(orgId) };
  } catch {
    return { status: "error" };
  }
}

/**
 * Load one endpoint by id for the detail page. A non-uuid id, or a soft-deleted / cross-org / unknown id,
 * reads as `{status:"not_found"}` (the page 404s); a db fault is `{status:"error"}`. Owns + releases the pool.
 */
export async function loadEndpoint(
  orgId: string,
  id: string,
  readers?: EndpointReaders,
): Promise<EndpointResult> {
  if (!isUuid(id)) return { status: "not_found" };
  if (readers) return readEndpoint(orgId, id, readers);
  const app = await getTenantDb();
  try {
    return await readEndpoint(orgId, id, boundReaders(app));
  } finally {
    await app.end({ timeout: 5 }).catch(() => {});
  }
}

async function readEndpoint(
  orgId: string,
  id: string,
  r: EndpointReaders,
): Promise<EndpointResult> {
  try {
    const endpoint = await r.getEndpoint(orgId, id);
    return endpoint ? { status: "ok", endpoint } : { status: "not_found" };
  } catch {
    return { status: "error" };
  }
}
