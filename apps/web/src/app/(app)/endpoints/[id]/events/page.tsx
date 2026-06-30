import { PROVIDERS } from "@webhook-co/webhooks-spec";
import { Banner } from "@webhook-co/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EventsFilterBar } from "@/components/events-filter-bar";
import { EventsList } from "@/components/events-list";
import {
  firstParam,
  hasAppliedFilters,
  parseEventFilters,
  type EventFilterParams,
} from "@/lib/event-filters";
import { loadMoreEventsAction } from "@/server/event-actions";
import { loadEvents } from "@/server/events";
import { verifySession } from "@/server/session";

export const metadata: Metadata = {
  title: "Events · webhook.co",
};

export default async function EventsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    provider?: string | string[];
    status?: string | string[];
    from?: string | string[];
    to?: string | string[];
    search?: string | string[];
    range?: string | string[];
  }>;
}) {
  const session = await verifySession();
  const { id } = await params;
  const sp = await searchParams;
  // The raw URL filter values ride to the client list (and back into the load-more action); the page
  // coerces them to instant bounds for the first DB read. Both paths use the same parseEventFilters.
  // provider/status are MULTI-select (repeated params → string[]); firstParam keeps the single-value
  // params first-wins.
  const rawParams: EventFilterParams = {
    provider: sp.provider,
    status: sp.status,
    from: firstParam(sp.from),
    to: firstParam(sp.to),
    search: firstParam(sp.search),
    range: firstParam(sp.range),
  };
  const filters = parseEventFilters(rawParams, PROVIDERS);
  const result = await loadEvents(session.orgId, id, filters);

  // The list + the "Load older" action consume the FROZEN, fully-resolved bounds — exactly what
  // `parseEventFilters` produced here at this render's `now` — NOT the raw `?range`/`?from`/`?to`. This
  // keeps page 1 and every load-more on the identical window: a relative preset is frozen to its absolute
  // receivedAfter instant (so paging can't re-resolve `now` and drift), and because a preset OWNS the
  // range (the parser ignores from/to under a preset), we carry only `filters.receivedBefore` — never a
  // stray `?to` that the range-less load-more parse would otherwise honor and desync against page 1. The
  // filter bar reads `?range` from the URL directly for its own label/state; only the data path is frozen.
  const filterParams: EventFilterParams = {
    provider: rawParams.provider,
    status: rawParams.status,
    search: rawParams.search,
    from: filters.receivedAfter?.toISOString(),
    to: filters.receivedBefore?.toISOString(),
  };

  if (result.status === "not_found") notFound();

  // A soft-deleted endpoint's detail page 404s, so a deleted endpoint's events link back to the list.
  const deleted = result.status === "ok" && result.deleted;
  const backHref = deleted ? "/endpoints" : `/endpoints/${id}`;

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-8 p-8">
      <div className="flex flex-col gap-1.5">
        <Link
          href={backHref}
          className="text-sm text-fg-secondary underline-offset-4 hover:underline"
        >
          {deleted ? "← Endpoints" : "← Endpoint"}
        </Link>
        <h1 className="text-2xl font-semibold tracking-heading text-fg">Events</h1>
        {result.status === "ok" ? (
          <p className="leading-snug text-fg-secondary">{result.endpointName}</p>
        ) : null}
      </div>

      {deleted ? (
        <Banner tone="warn">
          This endpoint was deleted — it no longer receives webhooks. Its past events stay
          inspectable here.
        </Banner>
      ) : null}

      {result.status === "error" ? (
        <Banner tone="danger">We couldn&apos;t load these events. Refresh to try again.</Banner>
      ) : (
        <div className="flex flex-col gap-5">
          <EventsFilterBar providers={PROVIDERS} />
          <EventsList
            // Re-key on the endpoint + the (frozen) active filters so a filter change replaces the list's
            // once-seeded state with the freshly-filtered first page. `from` carries the resolved preset
            // bound, so changing the preset re-keys without a separate `range` term; a multi-select array
            // stringifies to a comma-join (distinct per selection).
            key={`${id}:${filterParams.provider ?? ""}:${filterParams.status ?? ""}:${filterParams.from ?? ""}:${filterParams.to ?? ""}:${filterParams.search ?? ""}`}
            endpointId={id}
            initialItems={result.items}
            initialCursor={result.nextCursor}
            filterParams={filterParams}
            isFiltered={hasAppliedFilters(filters)}
            loadMore={loadMoreEventsAction}
          />
        </div>
      )}
    </div>
  );
}
