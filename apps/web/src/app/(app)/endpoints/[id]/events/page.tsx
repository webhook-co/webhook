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
  }>;
}) {
  const session = await verifySession();
  const { id } = await params;
  const sp = await searchParams;
  // The raw URL filter values ride to the client list (and back into the load-more action); the page
  // coerces them to instant bounds for the first DB read. Both paths use the same parseEventFilters.
  // firstParam guards a repeated query param (`?provider=a&provider=b` → string[]) — first-wins.
  const filterParams: EventFilterParams = {
    provider: firstParam(sp.provider),
    status: firstParam(sp.status),
    from: firstParam(sp.from),
    to: firstParam(sp.to),
  };
  const filters = parseEventFilters(filterParams, PROVIDERS);
  const result = await loadEvents(session.orgId, id, filters);

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
            // Re-key on the endpoint AND the active filters so the list's once-seeded useState
            // (items/cursor) is replaced with the freshly-filtered first page on any filter change.
            key={`${id}:${filterParams.provider ?? ""}:${filterParams.status ?? ""}:${filterParams.from ?? ""}:${filterParams.to ?? ""}`}
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
