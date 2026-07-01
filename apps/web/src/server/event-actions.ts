"use server";

import { ORDER_KEY_RE, type Cursor } from "@webhook-co/shared";
import { PROVIDERS } from "@webhook-co/webhooks-spec";

import { parseEventFilters, type EventFilterParams } from "@/lib/event-filters";

import { logActionError } from "./action-log";
import { isUuid } from "./endpoints";
import {
  loadMoreEvents,
  revealHeader,
  type EventSummaryItem,
  type RevealHeaderResult,
} from "./events";
import { loadEventPayload, type PayloadResult } from "./payloads";
import { verifySession } from "./session";

export type LoadMoreEventsResult =
  | {
      readonly ok: true;
      readonly items: readonly EventSummaryItem[];
      readonly nextCursor: Cursor | null;
    }
  | { readonly ok: false };

/**
 * Fetch the next page of an endpoint's events (the list's "Load more"). Session + RLS-org-pinning is the
 * authz (any org member may read the org's events). The keyset cursor crosses the client boundary
 * unsigned — that is safe because RLS, not a MAC, is the boundary: a tampered cursor can only re-page the
 * caller's OWN org's events. We still guard the cursor shape (uuid id + a valid ISO-µs orderKey) so a crafted payload
 * can't reach the db as a malformed value (→ PG 22P02). A db fault returns `{ok:false}` (the list keeps
 * what it has) rather than throwing.
 */
export async function loadMoreEventsAction(input: {
  endpointId: string;
  cursor: Cursor;
  filters?: EventFilterParams;
}): Promise<LoadMoreEventsResult> {
  const session = await verifySession();

  const endpointId = input?.endpointId;
  if (typeof endpointId !== "string" || !isUuid(endpointId)) return { ok: false };

  // The cursor is a structured {orderKey, id} round-tripped through the client (this action is
  // independently callable). Validate both fields — a bad orderKey is also RLS-bounded + caught below, but
  // reject fast. `orderKey` is the UTC ISO-µs order key (see cursor.ts).
  const cursor = input?.cursor as { orderKey?: unknown; id?: unknown } | undefined;
  if (!cursor || typeof cursor.id !== "string" || !isUuid(cursor.id)) return { ok: false };
  if (typeof cursor.orderKey !== "string" || !ORDER_KEY_RE.test(cursor.orderKey)) {
    return { ok: false };
  }

  // Re-parse the active filters server-side (the action is independently callable): the SAME coercion +
  // provider validation the page used, so paging stays within the active filter set and a tampered or
  // unknown value is just dropped.
  const filters = parseEventFilters(input?.filters ?? {}, PROVIDERS);

  try {
    const page = await loadMoreEvents(
      session.orgId,
      endpointId,
      { orderKey: cursor.orderKey, id: cursor.id },
      filters,
    );
    return { ok: true, items: page.items, nextCursor: page.nextCursor };
  } catch (error) {
    logActionError("events.load_more_failed", error);
    return { ok: false };
  }
}

/**
 * Reveal one sensitive header's value on the event detail view. Session + RLS-org-pinning is the authz,
 * plus the same endpoint-scope guard the page read enforces; the value is re-read under RLS and returned
 * one explicit reveal at a time (never in the page payload). Guards endpointId + eventId (uuid) + index
 * (non-negative int) before the db. Returns `{ok:false}` for a bad input, an unknown endpoint/event, a
 * non-sensitive index, or a db fault.
 */
export async function revealHeaderAction(input: {
  endpointId: string;
  eventId: string;
  index: number;
}): Promise<RevealHeaderResult> {
  const session = await verifySession();
  const { endpointId, eventId, index } = input ?? {};
  if (typeof endpointId !== "string" || !isUuid(endpointId)) return { ok: false };
  if (typeof eventId !== "string" || !isUuid(eventId)) return { ok: false };
  if (!Number.isInteger(index) || index < 0) return { ok: false };

  try {
    const revealed = await revealHeader(session.orgId, { endpointId, eventId, index });
    return revealed ? { ok: true, value: revealed.value } : { ok: false };
  } catch (error) {
    logActionError("events.reveal_header_failed", error);
    return { ok: false };
  }
}

/**
 * Load an event's body for the inline preview (the payload viewer calls this on mount). Session +
 * RLS-org-pinning + endpoint scope is the authz; size/binary gating + the R2 read happen in
 * `loadEventPayload`, which never returns the R2 key. A bad input or unknown event resolves to
 * `{kind:"not_found"}`; a fault to `{kind:"error"}` (already logged inside).
 */
export async function loadEventPayloadAction(input: {
  endpointId: string;
  eventId: string;
}): Promise<PayloadResult> {
  const session = await verifySession();
  const { endpointId, eventId } = input ?? {};
  if (typeof endpointId !== "string" || typeof eventId !== "string") return { kind: "not_found" };
  return loadEventPayload(session.orgId, endpointId, eventId);
}
