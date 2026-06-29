"use server";

import type { Cursor } from "@webhook-co/shared";

import { logActionError } from "./action-log";
import { isUuid } from "./endpoints";
import {
  loadMoreEvents,
  revealHeader,
  type EventSummaryItem,
  type RevealHeaderResult,
} from "./events";
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
 * caller's OWN org's events. We still guard the cursor shape (uuid id + a valid Date) so a crafted payload
 * can't reach the db as a malformed value (→ PG 22P02). A db fault returns `{ok:false}` (the list keeps
 * what it has) rather than throwing.
 */
export async function loadMoreEventsAction(input: {
  endpointId: string;
  cursor: Cursor;
}): Promise<LoadMoreEventsResult> {
  const session = await verifySession();

  const endpointId = input?.endpointId;
  if (typeof endpointId !== "string" || !isUuid(endpointId)) return { ok: false };

  const cursor = input?.cursor as { receivedAt?: unknown; id?: unknown } | undefined;
  if (!cursor || typeof cursor.id !== "string" || !isUuid(cursor.id)) return { ok: false };
  const receivedAt =
    cursor.receivedAt instanceof Date ? cursor.receivedAt : new Date(cursor.receivedAt as string);
  if (Number.isNaN(receivedAt.getTime())) return { ok: false };

  try {
    const page = await loadMoreEvents(session.orgId, endpointId, { receivedAt, id: cursor.id });
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
