import { PROVIDERS } from "@webhook-co/webhooks-spec";
import { Banner, PageContainer, PageHeader } from "@webhook-co/ui";
import type { Metadata } from "next";

import { EventsFilterBar } from "@/components/events-filter-bar";
import { OrgEventsList } from "@/components/org-events-list";
import { DEFAULT_ORG_EVENTS_RANGE } from "@/lib/date-range";
import {
  firstParam,
  hasAppliedFilters,
  parseEventFilters,
  type EventFilterParams,
} from "@/lib/event-filters";
import { queryString } from "@/lib/org-url";
import { loadMoreOrgEventsAction } from "@/server/event-actions";
import { loadOrgEvents } from "@/server/events";
import { requireActiveOrgAccess } from "@/server/org-access";

export const metadata: Metadata = {
  title: "Events · webhook.co",
};

/**
 * The consolidated org-wide events browse.
 *
 * Events are otherwise reachable only THROUGH an endpoint, which is several clicks from "what just arrived
 * anywhere?". Rows still deep-link to the EXISTING per-endpoint detail path — there is deliberately no second
 * event-detail surface.
 */
export default async function OrgEventsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    provider?: string | string[];
    status?: string | string[];
    from?: string | string[];
    to?: string | string[];
    search?: string | string[];
    range?: string | string[];
    endpointId?: string | string[];
  }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  // subPath carries the query so a canonicalizing 308 (mis-cased / renamed slug) keeps the reader's filters
  // and cursor — a shared, filtered events link must survive a rename intact.
  const session = await requireActiveOrgAccess(slug, `/events${queryString(sp)}`);

  // DEFAULT RANGE — applied ONLY when the reader has expressed no date intent at all.
  //
  // Unlike the per-endpoint page, an unfiltered org-wide browse defaults to a window rather than all time.
  // Measured: the keyset's `limit + 1` early-stop does NOT hold once a residual filter makes the planner
  // abandon the ordered index — the resulting Sort is a BLOCKING operator that consumes the entire input
  // before emitting row 1 (578ms @1.8M rows, ~32s @100M; 29ms with a bound). 7d is also the Free plan's
  // retention window, so for most orgs it hides nothing that still exists.
  //
  // The `hasDateIntent` guard is load-bearing, not defensive. A bare `?? DEFAULT` is WRONG: picking a custom
  // calendar range pushes `{from, to, range: ""}` (the two modes are mutually exclusive, so each clears the
  // other), and with no `?range` the default re-injected itself — the preset branch then OWNS the window and
  // parseEventFilters IGNORES from/to. A reader who picked Jan 1-9 saw the last 7 days while the chip read
  // "Custom range": silently wrong data, with the UI asserting the opposite. Caught in review, on prod.
  const hasDateIntent =
    firstParam(sp.range) !== undefined ||
    firstParam(sp.from) !== undefined ||
    firstParam(sp.to) !== undefined;
  const range = hasDateIntent ? firstParam(sp.range) : DEFAULT_ORG_EVENTS_RANGE;

  const rawParams: EventFilterParams = {
    provider: sp.provider,
    status: sp.status,
    from: firstParam(sp.from),
    to: firstParam(sp.to),
    search: firstParam(sp.search),
    range,
    endpointId: firstParam(sp.endpointId),
  };
  const filters = parseEventFilters(rawParams, PROVIDERS);
  const result = await loadOrgEvents(session.orgId, filters);

  // The endpoint facet's vocabulary, from the SAME map that labels the rows — one read, one snapshot, so the
  // picker can never offer an endpoint the table cannot name. Sorted by name (the visible label), with
  // deleted ones last: they are selectable (ADR-0076 keeps their events listable) but shouldn't crowd the
  // live ones.
  const endpointNames = result.status === "ok" ? result.endpointNames : {};
  const endpointOptions = Object.entries(endpointNames)
    .map(([id, e]) => ({ id, name: e.name, deleted: e.deleted }))
    .sort((a, b) => Number(a.deleted) - Number(b.deleted) || a.name.localeCompare(b.name));

  // FROZEN BOUNDS — the same discipline the per-endpoint page uses. The list and the "Load older" action get
  // the fully-resolved absolute instants this render produced, never the raw ?range/?from/?to: a relative
  // preset must not re-resolve `now` on page 2 and drift off page 1's window. A preset OWNS the range (the
  // parser ignores from/to under one), so only filters.receivedBefore rides along — never a stray ?to that a
  // range-less load-more parse would honour and desync against. The filter bar reads ?range from the URL for
  // its own label; only the DATA path is frozen.
  const filterParams: EventFilterParams = {
    provider: rawParams.provider,
    status: rawParams.status,
    search: rawParams.search,
    endpointId: rawParams.endpointId,
    from: filters.receivedAfter?.toISOString(),
    to: filters.receivedBefore?.toISOString(),
  };

  // Re-seed the client list whenever the filter set changes, so a filter change replaces the once-seeded
  // state with this render's fresh first page rather than appending onto a stale one.
  const listKey = [
    rawParams.provider,
    rawParams.status,
    rawParams.search,
    rawParams.endpointId,
    filterParams.from,
    filterParams.to,
  ]
    .map((v) => (Array.isArray(v) ? v.join(",") : (v ?? "")))
    .join("|");

  return (
    <PageContainer>
      <PageHeader title="Events" description="Every event captured across all your endpoints." />
      <EventsFilterBar providers={[...PROVIDERS]} endpoints={endpointOptions} />
      {result.status === "error" ? (
        // A read FAULT is not an empty result. Rendering the list here printed "No events match these
        // filters" over a database error — telling the reader their filters found nothing when in fact we
        // failed. The per-endpoint page uses a danger Banner for exactly this; match it.
        <Banner tone="danger">We couldn&apos;t load your events. Refresh to try again.</Banner>
      ) : (
        <OrgEventsList
          key={listKey}
          initialItems={result.items}
          initialCursor={result.nextCursor}
          filterParams={filterParams}
          isFiltered={hasAppliedFilters(filters)}
          endpointNames={result.endpointNames}
          loadMore={loadMoreOrgEventsAction.bind(null, session.slug)}
        />
      )}
    </PageContainer>
  );
}
