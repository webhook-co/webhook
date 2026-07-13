import type { Metadata } from "next";
import { PageContainer } from "@webhook-co/ui";

import { EndpointsManager } from "@/components/endpoints-manager";
import { EndpointsSearch } from "@/components/endpoints-search";
import { firstParam } from "@/lib/event-filters";
import {
  createEndpointAction,
  deleteEndpointAction,
  rotateEndpointAction,
} from "@/server/endpoint-actions";
import { loadEndpoints } from "@/server/endpoints";
import { requireOrgAccess } from "@/server/org-access";

export const metadata: Metadata = {
  title: "Endpoints · webhook.co",
};

export default async function EndpointsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ name?: string | string[] }>;
}) {
  const { slug } = await params;
  // subPath: a mis-cased or retired slug 308s to the canonical URL with this deep link intact.
  const session = await requireOrgAccess(slug, "/endpoints");
  const { name } = await searchParams;
  const trimmed = firstParam(name)?.trim();
  const result = await loadEndpoints(session.orgId, trimmed || undefined);

  return (
    <PageContainer>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">Endpoints</h1>
        <p className="leading-snug text-fg-secondary">
          Each endpoint gives you a signed webhook URL to receive webhooks. Create one and point
          your provider at it; rotate or delete it anytime from its page.
        </p>
      </div>
      <EndpointsSearch />
      <EndpointsManager
        // No `key` remount on filter change — the manager re-syncs its list from initialResult itself,
        // so an ingest URL shown mid-search isn't discarded by a search-debounce navigation.
        initialResult={result}
        nameFilter={trimmed}
        createEndpoint={createEndpointAction.bind(null, session.slug)}
        rotateEndpoint={rotateEndpointAction.bind(null, session.slug)}
        deleteEndpoint={deleteEndpointAction.bind(null, session.slug)}
      />
    </PageContainer>
  );
}
