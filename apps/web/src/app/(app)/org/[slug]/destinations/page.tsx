import { Banner, PageContainer } from "@webhook-co/ui";
import type { Metadata } from "next";

import { ReplayDestinationsManager } from "@/components/replay-destinations-manager";
import { loadDestinations } from "@/server/replay-destinations";
import { requireOrgAccess } from "@/server/org-access";

export const metadata: Metadata = {
  title: "Destinations · webhook.co",
};

export default async function DestinationsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await requireOrgAccess(slug, "/destinations");
  const result = await loadDestinations(session.orgId);

  return (
    <PageContainer>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">Destinations</h1>
        <p className="leading-snug text-fg-secondary">
          The public https URLs you can replay captured events to — every delivery is signed.
        </p>
      </div>

      {result.status === "error" ? (
        <Banner tone="danger">We couldn&apos;t load destinations. Refresh to try again.</Banner>
      ) : (
        <ReplayDestinationsManager slug={session.slug} initial={result.items} />
      )}
    </PageContainer>
  );
}
