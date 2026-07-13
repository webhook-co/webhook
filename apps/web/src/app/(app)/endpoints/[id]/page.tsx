import { Banner, PageContainer } from "@webhook-co/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { EndpointDedupManager } from "@/components/endpoint-dedup-manager";
import { EndpointDetail } from "@/components/endpoint-detail";
import { IngestUrlReveal, IngestUrlRevealSkeleton } from "@/components/ingest-url-reveal";
import { ProviderSecretsManager } from "@/components/provider-secrets-manager";
import {
  deleteEndpointAction,
  rotateEndpointAction,
  updateEndpointDedupAction,
} from "@/server/endpoint-actions";
import { loadEndpoint } from "@/server/endpoints";
import {
  addProviderSecretAction,
  revokeProviderSecretAction,
} from "@/server/provider-secret-actions";
import { loadProviderSecrets } from "@/server/provider-secrets";
import { requireOrgAccess } from "@/server/org-access";

export const metadata: Metadata = {
  title: "Endpoint · webhook.co",
};

// The rendered HTML embeds the always-shown ingest URL (a bearer credential), so this page must never be
// cached at the edge/browser. verifySession() already makes it dynamic; force-dynamic makes the no-store
// posture explicit (S8-remainder / ADR-0101).
export const dynamic = "force-dynamic";

export default async function EndpointDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireOrgAccess();
  const { id } = await params;
  // The endpoint detail + its provider (inbound-verification) secrets are independent org+id reads — run
  // them concurrently. The always-shown ingest URL is NOT awaited here: its reveal is a cross-cloud engine
  // RPC (a cold Hyperdrive read + a KMS unseal) that used to block the whole page render, so it now streams
  // in on its own <Suspense> boundary (IngestUrlReveal) — the page paints immediately.
  const [result, secrets] = await Promise.all([
    loadEndpoint(session.orgId, id),
    loadProviderSecrets(session.orgId, id),
  ]);

  if (result.status === "not_found") notFound();

  return (
    <PageContainer>
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
        <>
          <EndpointDetail
            endpoint={result.endpoint}
            ingestUrlSlot={
              <Suspense fallback={<IngestUrlRevealSkeleton />}>
                <IngestUrlReveal orgId={session.orgId} endpointId={id} />
              </Suspense>
            }
            rotateEndpoint={rotateEndpointAction}
            deleteEndpoint={deleteEndpointAction}
          />
          {secrets.status === "error" ? (
            <Banner tone="danger">
              We couldn&apos;t load this endpoint&apos;s provider secrets. Refresh to try again.
            </Banner>
          ) : (
            <ProviderSecretsManager
              endpointId={id}
              initial={secrets.items}
              add={addProviderSecretAction}
              revoke={revokeProviderSecretAction}
            />
          )}
          <EndpointDedupManager
            endpointId={result.endpoint.id}
            initial={result.endpoint.dedupConfig}
            update={updateEndpointDedupAction}
          />
        </>
      )}
    </PageContainer>
  );
}
