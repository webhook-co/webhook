import { Banner } from "@webhook-co/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EndpointDetail } from "@/components/endpoint-detail";
import { deleteEndpointAction, rotateEndpointAction } from "@/server/endpoint-actions";
import { loadEndpoint } from "@/server/endpoints";
import { verifySession } from "@/server/session";

export const metadata: Metadata = {
  title: "Endpoint · webhook.co",
};

export default async function EndpointDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await verifySession();
  const { id } = await params;
  const result = await loadEndpoint(session.orgId, id);

  if (result.status === "not_found") notFound();

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-8 p-8">
      <div className="flex flex-col gap-1.5">
        <Link
          href="/endpoints"
          className="text-sm text-fg-secondary underline-offset-4 hover:underline"
        >
          ← Endpoints
        </Link>
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-heading text-fg">Endpoint</h1>
          <Link
            href={`/endpoints/${id}/events`}
            className="text-sm font-medium text-fg underline-offset-4 hover:underline"
          >
            View events →
          </Link>
        </div>
      </div>
      {result.status === "error" ? (
        <Banner tone="danger">We couldn&apos;t load this endpoint. Refresh to try again.</Banner>
      ) : (
        <EndpointDetail
          endpoint={result.endpoint}
          rotateEndpoint={rotateEndpointAction}
          deleteEndpoint={deleteEndpointAction}
        />
      )}
    </div>
  );
}
