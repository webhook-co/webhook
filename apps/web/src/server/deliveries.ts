import "server-only";

import { withTenant, type Sql } from "@webhook-co/db/client";
import { getDelivery, listDeliveries } from "@webhook-co/db/reads";
import type { Cursor, Delivery, DeliveryStatus } from "@webhook-co/shared";

import { logActionError } from "./action-log";
import { withTenantDb } from "./db";
import { isUuid } from "./endpoints";

// The deliveries surfaces for the dashboard (deliveries.list / deliveries.get). Deliveries are the
// OUTBOUND half — a delivery_attempts row is the record of the engine (or a manual replay) delivering an
// event to a registered destination. Read live via the Lane reads under withTenant(orgId) as webhook_app;
// RLS (the session orgId) is the tenant backstop, so these queries never filter by org_id themselves and a
// cross-org id simply isn't visible (no existence oracle). The db `Delivery` view already omits orgId, so
// the browser-safe item is the view as-is — no internal pointer to strip.

/** The deliveries-list / detail row shape for the dashboard. `Delivery` already excludes orgId. */
export type DeliveryItem = Delivery;

/** The active deliveries filters — status is a multi-select; destination/subscription scope contextual views. */
export interface DeliveryFilters {
  readonly status?: readonly DeliveryStatus[];
  readonly destinationId?: string;
  readonly subscriptionId?: string;
}

export interface DeliveriesPage {
  readonly items: readonly DeliveryItem[];
  readonly nextCursor: Cursor | null;
}

export type DeliveriesResult =
  | {
      readonly status: "ok";
      readonly items: readonly DeliveryItem[];
      readonly nextCursor: Cursor | null;
    }
  | { readonly status: "error" };

export type DeliveryResult =
  | { readonly status: "ok"; readonly delivery: DeliveryItem }
  | { readonly status: "not_found" }
  | { readonly status: "error" };

/** The reads this surface needs, injectable for tests; the default binds the per-request tenant tx. */
export interface DeliveryReaders {
  firstPage(orgId: string, filters?: DeliveryFilters): Promise<DeliveriesPage>;
  listMore(orgId: string, cursor: Cursor, filters?: DeliveryFilters): Promise<DeliveriesPage>;
  getDelivery(orgId: string, id: string): Promise<DeliveryItem | null>;
}

function boundReaders(app: Sql): DeliveryReaders {
  return {
    firstPage: (orgId, filters) =>
      withTenant(app, orgId, async (tx) => {
        // No limit → the shared DB default (clampLimit) so the page size can't drift from other surfaces.
        const page = await listDeliveries(tx, { ...filters });
        return { items: page.items, nextCursor: page.nextCursor };
      }),
    listMore: (orgId, cursor, filters) =>
      withTenant(app, orgId, async (tx) => {
        const page = await listDeliveries(tx, { ...filters, cursor });
        return { items: page.items, nextCursor: page.nextCursor };
      }),
    getDelivery: (orgId, id) => withTenant(app, orgId, (tx) => getDelivery(tx, id)),
  };
}

/**
 * Load the org's first page of deliveries (newest-first) for the dashboard list. A db fault reads as
 * `{status:"error"}` (logged, scrubbed). Tests inject `readers` and skip the pool.
 */
export async function loadDeliveries(
  orgId: string,
  filters?: DeliveryFilters,
  readers?: DeliveryReaders,
): Promise<DeliveriesResult> {
  const r = readers ?? null;
  try {
    const page = r
      ? await r.firstPage(orgId, filters)
      : await withTenantDb((app) => boundReaders(app).firstPage(orgId, filters));
    return { status: "ok", items: page.items, nextCursor: page.nextCursor };
  } catch (error) {
    logActionError("deliveries.list_failed", error);
    return { status: "error" };
  }
}

/**
 * Fetch one more page of the org's deliveries (the "Load older" path). RLS scopes the read to the caller's
 * own deliveries; the active filters are threaded so paging stays within the filter set. Tests inject `readers`.
 */
export async function loadMoreDeliveries(
  orgId: string,
  cursor: Cursor,
  filters?: DeliveryFilters,
  readers?: DeliveryReaders,
): Promise<DeliveriesPage> {
  if (readers) return readers.listMore(orgId, cursor, filters);
  return withTenantDb((app) => boundReaders(app).listMore(orgId, cursor, filters));
}

/**
 * Load one delivery by id for the detail page. A non-uuid id, or an unknown / cross-org delivery, reads as
 * `{status:"not_found"}` (the page 404s — no existence oracle); a db fault is `{status:"error"}` (logged).
 */
export async function loadDelivery(
  orgId: string,
  id: string,
  readers?: DeliveryReaders,
): Promise<DeliveryResult> {
  if (!isUuid(id)) return { status: "not_found" };
  try {
    const delivery = readers
      ? await readers.getDelivery(orgId, id)
      : await withTenantDb((app) => boundReaders(app).getDelivery(orgId, id));
    return delivery ? { status: "ok", delivery } : { status: "not_found" };
  } catch (error) {
    logActionError("deliveries.get_failed", error);
    return { status: "error" };
  }
}
