"use server";

import { ORDER_KEY_RE, type Cursor } from "@webhook-co/shared";

import { parseDeliveryFilters, type DeliveryFilterParams } from "@/lib/delivery-filters";

import { logActionError } from "./action-log";
import { loadMoreDeliveries, type DeliveryItem } from "./deliveries";
import { isUuid } from "./endpoints";
import { verifySession } from "./session";

export type LoadMoreDeliveriesResult =
  | {
      readonly ok: true;
      readonly items: readonly DeliveryItem[];
      readonly nextCursor: Cursor | null;
    }
  | { readonly ok: false };

/**
 * Fetch the next page of the org's deliveries (the list's "Load older"). Session + RLS-org-pinning is the
 * authz (any org member may read the org's deliveries). The keyset cursor crosses the client boundary
 * unsigned — safe because RLS, not a MAC, is the boundary: a tampered cursor can only re-page the caller's
 * OWN org's deliveries. We still guard the cursor shape (uuid id + a valid ISO-µs orderKey) so a crafted
 * payload can't reach the db as a malformed value (→ PG 22P02). The active filters are re-parsed server-side (the action
 * is independently callable) with the SAME coercion + status validation the page used, so paging stays
 * within the filter set. A db fault returns `{ok:false}` (the list keeps what it has) rather than throwing.
 */
export async function loadMoreDeliveriesAction(input: {
  cursor: Cursor;
  filters?: DeliveryFilterParams;
}): Promise<LoadMoreDeliveriesResult> {
  const session = await verifySession();

  // The cursor is a structured {orderKey, id} round-tripped through the client; fail closed on any other
  // shape before it reaches SQL — a uuid id + an ISO-µs orderKey (see cursor.ts).
  const cursor = input?.cursor as { orderKey?: unknown; id?: unknown } | undefined;
  if (!cursor || typeof cursor.id !== "string" || !isUuid(cursor.id)) return { ok: false };
  if (typeof cursor.orderKey !== "string" || !ORDER_KEY_RE.test(cursor.orderKey))
    return { ok: false };

  const filters = parseDeliveryFilters(input?.filters ?? {});

  try {
    const page = await loadMoreDeliveries(
      session.orgId,
      { orderKey: cursor.orderKey, id: cursor.id },
      filters,
    );
    return { ok: true, items: page.items, nextCursor: page.nextCursor };
  } catch (error) {
    logActionError("deliveries.load_more_failed", error);
    return { ok: false };
  }
}
