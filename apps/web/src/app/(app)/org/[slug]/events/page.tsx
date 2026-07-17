import { PROVIDERS } from "@webhook-co/webhooks-spec";
import { Banner, PageContainer, PageHeader } from "@webhook-co/ui";
import type { Metadata } from "next";

import { EventsFilterBar } from "@/components/events-filter-bar";
import { OrgEventsList } from "@/components/org-events-list";
import { DEFAULT_ORG_EVENTS_RANGE, effectiveDateRange } from "@/lib/date-range";
import {
  type EventFilterParams,
  filterListKey,
  firstParam,
  hasAppliedFilters,
  parseEventFilters,
} from "@/lib/event-filters";
import { queryString } from "@/lib/org-url";
import { loadMoreOrgEventsAction } from "@/server/event-actions";
import { getListenWsUrl } from "@/server/env";
import { loadOrgEvents } from "@/server/events";
import { mintOrgListenTicketAction } from "@/server/listen-ticket-actions";
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
    method?: string | string[];
    dedupStrategy?: string | string[];
    eventType?: string | string[];
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
  //
  // `?range=all` is the OTHER thing that must count as intent — the explicit escape hatch. Without it in this
  // predicate the default silently swallows it and "Any time" means "last 7 days", which is the same failure
  // wearing a different hat. Note the range arm tests isDateIntent (a KNOWN token), not mere presence: a
  // hand-edited `?range=bogus` is a typo and must fall back to the default, never widen to all-time.
  const range = effectiveDateRange(
    { range: firstParam(sp.range), from: firstParam(sp.from), to: firstParam(sp.to) },
    DEFAULT_ORG_EVENTS_RANGE,
  );

  const rawParams: EventFilterParams = {
    provider: sp.provider,
    status: sp.status,
    from: firstParam(sp.from),
    to: firstParam(sp.to),
    search: firstParam(sp.search),
    range,
    endpointId: firstParam(sp.endpointId),
    method: sp.method,
    dedupStrategy: sp.dedupStrategy,
    eventType: firstParam(sp.eventType),
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
    method: rawParams.method,
    dedupStrategy: rawParams.dedupStrategy,
    eventType: rawParams.eventType,
    from: filters.receivedAfter?.toISOString(),
    to: filters.receivedBefore?.toISOString(),
  };

  // Re-seed the client list whenever the filter set changes, so a filter change replaces the once-seeded
  // state with this render's fresh first page rather than appending onto a stale one. filterListKey
  // percent-encodes each part so a free-text search/eventType containing `|` or `,` can't forge the delimiter
  // and make two distinct filter states collide onto one key (which would leave a stale first page).
  const listKey = filterListKey([
    rawParams.provider,
    rawParams.status,
    rawParams.search,
    rawParams.endpointId,
    rawParams.method,
    rawParams.dedupStrategy,
    rawParams.eventType,
    filterParams.from,
    filterParams.to,
  ]);

  return (
    <PageContainer>
      <PageHeader title="Events" description="Every event captured across all your endpoints." />
      {/* defaultRange is what makes the 7d default DISCLOSED rather than silent: the bar reads the URL, the
          default lives here, so without telling it the chip said "Date range" over 7 days of data. The
          per-endpoint bar omits it and stays all-time. */}
      <EventsFilterBar
        providers={[...PROVIDERS]}
        endpoints={endpointOptions}
        defaultRange={DEFAULT_ORG_EVENTS_RANGE}
      />
      {result.status === "error" ? (
        // A read FAULT is not an empty result. Rendering the list here printed "No events match these
        // filters" over a database error — telling the reader their filters found nothing when in fact we
        // failed. The per-endpoint page uses a danger Banner for exactly this; match it.
        //
        // The two messages differ because the two situations differ. A timed-out browse is DETERMINISTIC: the
        // same query will time out again, so "Refresh to try again" is advice that cannot work, and the only
        // thing that helps is a narrower window — which the reader has no way to guess unless we say it.
        <Banner tone="danger">
          {result.reason === "timeout"
            ? "That's a lot of history to search at once, and the query timed out. Narrow the date range (or filter to one endpoint) and try again."
            : "We couldn't load your events. Refresh to try again."}
        </Banner>
      ) : (
        <OrgEventsList
          key={listKey}
          initialItems={result.items}
          initialCursor={result.nextCursor}
          filterParams={filterParams}
          isFiltered={hasAppliedFilters(filters)}
          endpointNames={result.endpointNames}
          loadMore={loadMoreOrgEventsAction.bind(null, session.slug)}
          liveWsUrl={getListenWsUrl()}
          mintTicket={mintOrgListenTicketAction.bind(null, session.slug)}
        />
      )}
    </PageContainer>
  );
}
