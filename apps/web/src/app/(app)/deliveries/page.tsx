import { Banner } from "@webhook-co/ui";
import type { Metadata } from "next";

import { DeliveriesFilterBar, DeliveriesList } from "@/components/deliveries-list";
import {
  hasAppliedDeliveryFilters,
  parseDeliveryFilters,
  type DeliveryFilterParams,
} from "@/lib/delivery-filters";
import { loadMoreDeliveriesAction } from "@/server/delivery-actions";
import { loadDeliveries } from "@/server/deliveries";
import { verifySession } from "@/server/session";

export const metadata: Metadata = {
  title: "Deliveries · webhook.co",
};

export default async function DeliveriesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const session = await verifySession();
  const sp = await searchParams;
  // The raw URL filter value rides to the client list (and back into the load-more action); the page
  // coerces it to a validated status set for the first DB read. Both paths use the same
  // parseDeliveryFilters, so page 1 and every "Load older" agree on which filters are applied.
  const rawParams: DeliveryFilterParams = { status: sp.status };
  const filters = parseDeliveryFilters(rawParams);
  const result = await loadDeliveries(session.orgId, filters);

  const statusKey = Array.isArray(rawParams.status)
    ? rawParams.status.join(",")
    : (rawParams.status ?? "");

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-8 p-8">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">Deliveries</h1>
        <p className="leading-snug text-fg-secondary">
          Every attempt to deliver an event to a destination.
        </p>
      </div>

      {result.status === "error" ? (
        <Banner tone="danger">We couldn&apos;t load deliveries. Refresh to try again.</Banner>
      ) : (
        <div className="flex flex-col gap-5">
          <DeliveriesFilterBar />
          <DeliveriesList
            // Re-key on the active status filter so a filter change replaces the list's once-seeded state
            // with the freshly-filtered first page.
            key={statusKey}
            initialItems={result.items}
            initialCursor={result.nextCursor}
            filterParams={rawParams}
            isFiltered={hasAppliedDeliveryFilters(filters)}
            loadMore={loadMoreDeliveriesAction}
          />
        </div>
      )}
    </div>
  );
}
