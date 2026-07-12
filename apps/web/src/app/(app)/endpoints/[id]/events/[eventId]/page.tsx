import { Banner, PageContainer } from "@webhook-co/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EventDetail } from "@/components/event-detail";
import {
  deleteEventAction,
  loadEventPayloadAction,
  revealHeaderAction,
} from "@/server/event-actions";
import { loadEvent } from "@/server/events";
import { replayToDestinationAction } from "@/server/replay-actions";
import { loadDestinations } from "@/server/replay-destinations";
import { verifySession } from "@/server/session";

export const metadata: Metadata = {
  title: "Event · webhook.co",
};

export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ id: string; eventId: string }>;
}) {
  const session = await verifySession();
  const { id, eventId } = await params;
  // The event read and the replay-picker's destinations are independent org-scoped reads — run concurrently.
  const [result, destResult] = await Promise.all([
    loadEvent(session.orgId, id, eventId),
    loadDestinations(session.orgId),
  ]);

  if (result.status === "not_found") notFound();

  return (
    <PageContainer>
      <div className="flex flex-col gap-1.5">
        <Link
          href={`/endpoints/${id}/events`}
          className="text-sm text-fg-secondary underline-offset-4 hover:underline"
        >
          ← Events
        </Link>
        <h1 className="text-2xl font-semibold tracking-heading text-fg">Event</h1>
      </div>

      {result.status === "error" ? (
        <Banner tone="danger">We couldn&apos;t load this event. Refresh to try again.</Banner>
      ) : (
        <EventDetail
          event={result.event}
          endpointId={id}
          revealHeader={revealHeaderAction}
          loadPayload={loadEventPayloadAction}
          destinations={destResult.status === "ok" ? destResult.items : []}
          destinationsError={destResult.status === "error"}
          replay={replayToDestinationAction}
          deleteEvent={deleteEventAction}
        />
      )}
    </PageContainer>
  );
}
