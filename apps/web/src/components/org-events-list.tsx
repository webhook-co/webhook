"use client";

import { Banner, Button } from "@webhook-co/ui";
import type { Cursor } from "@webhook-co/shared";
import * as React from "react";

import type { EventFilterParams } from "@/lib/event-filters";
import { useEventPaging } from "@/lib/use-event-paging";
import type { LoadMoreEventsResult } from "@/server/event-actions";
import type { EventSummaryItem } from "@/server/events";

import { EventsTable, type EndpointLabels } from "./events-table";

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
}

/**
 * The consolidated org-wide events list.
 *
 * Thin by design: `useEventPaging` owns the page state + the same-tick latch, and `EventsTable` owns the rows
 * — so this list and the per-endpoint one cannot drift on either. It renders NO live toggle: the listen ticket
 * is endpoint-scoped today, so an org-wide tail is a separate slice, and `EventsTable` needs nothing from it.
 */
export function OrgEventsList({
  initialItems,
  initialCursor,
  filterParams,
  isFiltered,
  endpointNames,
  loadMore,
}: OrgEventsListProps) {
  // Memoised so the pager's callback identity is stable across renders.
  const fetchPage = React.useCallback(
    (cursor: Cursor) => loadMore({ cursor, filters: filterParams }),
    [filterParams, loadMore],
  );
  const {
    items,
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
