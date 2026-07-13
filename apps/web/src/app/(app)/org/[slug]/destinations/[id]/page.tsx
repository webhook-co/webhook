import { Banner, StatusPill, PageContainer } from "@webhook-co/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DeliveriesList } from "@/components/deliveries-list";
import { destinationCopy, destinationDisplayStatus } from "@/lib/destination-copy";
import { formatDate } from "@/lib/format";
import { loadMoreDeliveriesAction } from "@/server/delivery-actions";
import { loadDeliveries } from "@/server/deliveries";
import { isUuid } from "@/server/endpoints";
import { loadDestinations } from "@/server/replay-destinations";
import { requireOrgAccess } from "@/server/org-access";

export const metadata: Metadata = {
  title: "Destination · webhook.co",
};

export default async function DestinationDetailPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id: rawId } = await params;
  const session = await requireOrgAccess(slug, `/destinations/${rawId}`);
  // A non-uuid can never name a destination (the id column is uuid); treat it as not-found rather than
  // letting it reach a query as a bad cast.
  if (!isUuid(rawId)) notFound();
  // isUuid is case-insensitive, but the stored ids are canonical lowercase — normalize so the exact-match
  // `find` (below) can't false-404 an owned destination reached via an uppercase-hex id.
  const id = rawId.toLowerCase();

  // There's no single-destination db read; the summary comes from filtering the org's destinations by the
  // route id. That list read and this destination's deliveries are independent org-scoped reads — run them
  // concurrently.
  const [destResult, delResult] = await Promise.all([
    loadDestinations(session.orgId),
    loadDeliveries(session.orgId, { destinationId: id }),
  ]);

  if (destResult.status === "error") {
    return (
      <PageContainer>
        <div className="flex flex-col gap-1.5">
          <Link
            href={`/org/${session.slug}/destinations`}
            className="text-sm text-fg-secondary underline-offset-4 hover:underline"
          >
            ← Destinations
          </Link>
          <h1 className="text-2xl font-semibold tracking-heading text-fg">Destination</h1>
        </div>
        <Banner tone="danger">We couldn&apos;t load this destination. Refresh to try again.</Banner>
      </PageContainer>
    );
  }

  const destination = destResult.items.find((d) => d.id === id);
  if (!destination) notFound();

  const copy = destinationCopy(destinationDisplayStatus(destination));

  return (
    <PageContainer>
      <div className="flex flex-col gap-1.5">
        <Link
          href={`/org/${session.slug}/destinations`}
          className="text-sm text-fg-secondary underline-offset-4 hover:underline"
        >
          ← Destinations
        </Link>
        <h1 className="text-2xl font-semibold tracking-heading text-fg">Destination</h1>
      </div>

      <div className="flex flex-col gap-4 rounded-card border border-hairline bg-surface-sunken p-5">
        <div className="flex flex-wrap items-center gap-3">
          <code className="font-mono text-sm text-fg">{destination.url}</code>
          <StatusPill tone={copy.tone} title={copy.hint}>
            {copy.label}
          </StatusPill>
        </div>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <dt className="text-xs text-fg-muted">Label</dt>
            <dd className="text-sm text-fg-secondary">
              {destination.label ?? <span className="text-fg-muted">—</span>}
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-xs text-fg-muted">Ordering</dt>
            <dd className="text-sm text-fg-secondary">
              {destination.ordered ? "Strict (FIFO)" : "Best-effort"}
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-xs text-fg-muted">Created</dt>
            <dd className="text-sm text-fg-secondary">{formatDate(destination.createdAt)}</dd>
          </div>
        </dl>
      </div>

      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-lg font-semibold tracking-heading text-fg">
            Deliveries to this destination
          </h2>
          <p className="leading-snug text-fg-secondary">
            Every attempt to deliver an event to this destination.
          </p>
        </div>

        {delResult.status === "error" ? (
          <Banner tone="danger">We couldn&apos;t load deliveries. Refresh to try again.</Banner>
        ) : (
          <DeliveriesList
            // Key on the destination so a soft-nav to another destination REMOUNTS the list (it seeds
            // items/cursor from initialItems via useState on mount) — otherwise it would keep the previous
            // destination's rows + cursor under this URL (mirrors the global deliveries page's key).
            key={id}
            initialItems={delResult.items}
            initialCursor={delResult.nextCursor}
            filterParams={{ destinationId: id }}
            isFiltered={false}
            loadMore={loadMoreDeliveriesAction.bind(null, session.slug)}
          />
        )}
      </div>
    </PageContainer>
  );
}
