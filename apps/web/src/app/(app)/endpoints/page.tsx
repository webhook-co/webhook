import type { Metadata } from "next";

import { EndpointsManager } from "@/components/endpoints-manager";
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

export default async function EndpointsPage() {
  const session = await verifySession();
  const result = await loadEndpoints(session.orgId);

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-8 p-8">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">Endpoints</h1>
        <p className="leading-snug text-fg-secondary">
          Each endpoint gives you a signed webhook URL to receive webhooks. Create one and point
          your provider at it; rotate or delete it anytime from its page.
        </p>
      </div>
      <EndpointsManager
        initialResult={result}
        createEndpoint={createEndpointAction}
        rotateEndpoint={rotateEndpointAction}
        deleteEndpoint={deleteEndpointAction}
      />
    </div>
  );
}
