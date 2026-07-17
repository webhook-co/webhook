"use client";

import { Banner, Button } from "@webhook-co/ui";
import type { Cursor } from "@webhook-co/shared";
import * as React from "react";

import type { EventFilterParams } from "@/lib/event-filters";
import type { MintTicketResult, WebSocketCtor } from "@/lib/live-events";
import { useEventPaging } from "@/lib/use-event-paging";
import type { LoadMoreEventsResult } from "@/server/event-actions";
import type { EventSummaryItem } from "@/server/events";

import { EventsTable, type EndpointLabels } from "./events-table";
import { LiveTailBar } from "./live-tail-bar";

export interface OrgEventsListProps {
  readonly initialItems: readonly EventSummaryItem[];
  readonly initialCursor: Cursor | null;
  /** The active filters (raw), threaded into "Load older" so paging stays within the filtered set. */
  readonly filterParams: EventFilterParams;
  /** Whether a filter is actually APPLIED (from the PARSED filters) — drives the empty copy honestly. */
  readonly isFiltered: boolean;
  /** Endpoint id → name + deleted, for the Endpoint column. Includes soft-deleted endpoints (ADR-0076). */
  readonly endpointNames: EndpointLabels;
  readonly loadMore: (input: {
    cursor: Cursor;
    filters: EventFilterParams;
  }) => Promise<LoadMoreEventsResult>;
  /** The `wss://…/listen` URL for the ORG-WIDE live tail, derived server-side. Paired with `mintTicket`;
   *  when either is absent the Live toggle isn't rendered. */
  readonly liveWsUrl?: string;
  /** Mint an ORG-scoped listen ticket (the session-authed action, pre-bound with slug — no endpointId). */
  readonly mintTicket?: () => Promise<MintTicketResult>;
  /** Test seam: inject a FakeWebSocket. Undefined in the app → the browser `WebSocket`. */
  readonly webSocketCtor?: WebSocketCtor;
}

/**
 * The consolidated org-wide events list.
 *
 * Thin by design: `useEventPaging` owns the page state + the same-tick latch, `EventsTable` owns the rows, and
 * the shared `LiveTailBar` owns the live toggle — so this list and the per-endpoint one cannot drift on any of
 * them. The live tail here is ORG-SCOPED (no `endpointId`): a single tail across every endpoint, via an
 * org-scoped listen ticket. Live rows carry their own `endpointId`, so `EventsTable` renders the Endpoint
 * column for them through the same path as the paginated rows.
 */
export function OrgEventsList({
  initialItems,
  initialCursor,
  filterParams,
  isFiltered,
  endpointNames,
  loadMore,
  liveWsUrl,
  mintTicket,
  webSocketCtor,
}: OrgEventsListProps) {
  // Memoised so the pager's callback identity is stable across renders.
  const fetchPage = React.useCallback(
    (cursor: Cursor) => loadMore({ cursor, filters: filterParams }),
    [filterParams, loadMore],
  );
  const {
    items,
    setItems,
    cursor,
    pending,
    error,
    loadMore: handleLoadMore,
  } = useEventPaging({
    initialItems,
    initialCursor,
    loadMore: fetchPage,
  });

  return (
    <div className="flex flex-col gap-4">
      {/* Org-scoped: no endpointId → the tail spans every endpoint (scope comes from the org ticket). */}
      <LiveTailBar
        liveWsUrl={liveWsUrl}
        mintTicket={mintTicket}
        setItems={setItems}
        webSocketCtor={webSocketCtor}
      />
      <EventsTable
        items={items}
        isFiltered={isFiltered}
        endpointNames={endpointNames}
        emptyMessage="No events yet. Point a provider at an endpoint's webhook URL to start receiving events."
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}

      {cursor !== null ? (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={handleLoadMore} disabled={pending}>
            {pending ? "Loading…" : "Load older events"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
