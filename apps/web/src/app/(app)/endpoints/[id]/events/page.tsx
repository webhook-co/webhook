import { Banner } from "@webhook-co/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EventsList } from "@/components/events-list";
import { loadMoreEventsAction } from "@/server/event-actions";
import { loadEvents } from "@/server/events";
import { verifySession } from "@/server/session";

export const metadata: Metadata = {
  title: "Events · webhook.co",
};

export default async function EventsPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await verifySession();
  const { id } = await params;
  const result = await loadEvents(session.orgId, id);

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
        <EventsList
          // Remount per endpoint so the list's once-seeded useState (items/cursor) can't carry over if a
          // direct /endpoints/A/events → /endpoints/B/events navigation is ever added (same route segment).
          key={id}
          endpointId={id}
          initialItems={result.items}
          initialCursor={result.nextCursor}
          loadMore={loadMoreEventsAction}
        />
      )}
    </div>
  );
}
