import { Banner } from "@webhook-co/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EventDetail } from "@/components/event-detail";
import { revealHeaderAction } from "@/server/event-actions";
import { loadEvent } from "@/server/events";
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
  const result = await loadEvent(session.orgId, id, eventId);

  if (result.status === "not_found") notFound();

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-8 p-8">
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
        <EventDetail event={result.event} endpointId={id} revealHeader={revealHeaderAction} />
      )}
    </div>
  );
}
