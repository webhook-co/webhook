import { Banner } from "@webhook-co/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DeliveryDetail } from "@/components/delivery-detail";
import { loadDelivery } from "@/server/deliveries";
import { verifySession } from "@/server/session";

export const metadata: Metadata = {
  title: "Delivery · webhook.co",
};

export default async function DeliveryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await verifySession();
  const { id } = await params;
  const result = await loadDelivery(session.orgId, id);

  if (result.status === "not_found") notFound();

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-8 p-8">
      <div className="flex flex-col gap-1.5">
        <Link
          href="/deliveries"
          className="text-sm text-fg-secondary underline-offset-4 hover:underline"
        >
          ← Deliveries
        </Link>
        <h1 className="text-2xl font-semibold tracking-heading text-fg">Delivery</h1>
      </div>

      {result.status === "error" ? (
        <Banner tone="danger">We couldn&apos;t load this delivery. Refresh to try again.</Banner>
      ) : (
        <DeliveryDetail delivery={result.delivery} />
      )}
    </div>
  );
}
