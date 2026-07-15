import type { Metadata } from "next";
import { PageContainer } from "@webhook-co/ui";

import { EndpointsManager } from "@/components/endpoints-manager";
import { firstParam } from "@/lib/event-filters";
import {
  createEndpointAction,
  deleteEndpointAction,
  rotateEndpointAction,
} from "@/server/endpoint-actions";
import { loadEndpoints } from "@/server/endpoints";
import { requireActiveOrgAccess } from "@/server/org-access";

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
  const session = await requireActiveOrgAccess(slug, "/endpoints");
  const { name } = await searchParams;
  const trimmed = firstParam(name)?.trim();
  const result = await loadEndpoints(session.orgId, trimmed || undefined);

  return (
    <PageContainer>
      {/* Header, search, list, and the Create dialog all live inside the manager — the "Create endpoint"
          primary action sits in the page header (Team pattern), and the create dialog owns state the header
          would otherwise have to lift. */}
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
