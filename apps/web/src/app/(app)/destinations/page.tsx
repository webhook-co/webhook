import { Banner } from "@webhook-co/ui";
import type { Metadata } from "next";

import { ReplayDestinationsManager } from "@/components/replay-destinations-manager";
import { loadDestinations } from "@/server/replay-destinations";
import { verifySession } from "@/server/session";

export const metadata: Metadata = {
  title: "Destinations · webhook.co",
};

export default async function DestinationsPage() {
  const session = await verifySession();
  const result = await loadDestinations(session.orgId);

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-8 p-8">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">Destinations</h1>
        <p className="leading-snug text-fg-secondary">
          The public https URLs you can replay captured events to — every delivery is signed.
        </p>
      </div>

      {result.status === "error" ? (
        <Banner tone="danger">We couldn&apos;t load destinations. Refresh to try again.</Banner>
      ) : (
        <ReplayDestinationsManager initial={result.items} />
      )}
    </div>
  );
}
