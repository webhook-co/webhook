import type { Metadata } from "next";

import { EndpointsManager } from "@/components/endpoints-manager";
import { EndpointsSearch } from "@/components/endpoints-search";
import { firstParam } from "@/lib/event-filters";
import {
  createEndpointAction,
  deleteEndpointAction,
  rotateEndpointAction,
} from "@/server/endpoint-actions";
import { loadEndpoints } from "@/server/endpoints";
import { verifySession } from "@/server/session";

export const metadata: Metadata = {
  title: "Endpoints · webhook.co",
};

export default async function EndpointsPage({
  searchParams,
}: {
  searchParams: Promise<{ name?: string | string[] }>;
}) {
  const session = await verifySession();
  const { name } = await searchParams;
  const trimmed = firstParam(name)?.trim();
  const result = await loadEndpoints(session.orgId, trimmed || undefined);

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-8 p-8">
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
        // so a one-time ingest URL shown mid-search isn't discarded by a search-debounce navigation.
        initialResult={result}
        nameFilter={trimmed}
        createEndpoint={createEndpointAction}
        rotateEndpoint={rotateEndpointAction}
        deleteEndpoint={deleteEndpointAction}
      />
    </div>
  );
}
