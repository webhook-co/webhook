"use client";

import { Badge, Card, CardContent, CardHeader, CardTitle, CopyButton } from "@webhook-co/ui";
import { useRouter } from "next/navigation";

import { formatDateTime } from "@/lib/format";
import type { EndpointActionResult, RotateEndpointResult } from "@/server/endpoint-actions";
import type { EndpointItem } from "@/server/endpoints";

import { EndpointControls } from "./endpoint-controls";

export interface EndpointDetailProps {
  endpoint: EndpointItem;
  /** Rotate the ingest token (hard cutover) → the NEW one-time URL. Injected by the gated page. */
  rotateEndpoint: (endpointId: string) => Promise<RotateEndpointResult>;
  /** Soft-delete the endpoint. Injected by the gated page. */
  deleteEndpoint: (endpointId: string) => Promise<EndpointActionResult>;
}

export function EndpointDetail({ endpoint, rotateEndpoint, deleteEndpoint }: EndpointDetailProps) {
  const router = useRouter();

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>{endpoint.name}</CardTitle>
          <Badge tone={endpoint.paused ? "neutral" : "ok"}>
            {endpoint.paused ? "Paused" : "Active"}
          </Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-fg-secondary">Endpoint ID</dt>
            <dd className="flex items-center gap-2">
              <code className="font-mono text-fg">{endpoint.id}</code>
              <CopyButton value={endpoint.id} size="sm" />
            </dd>
            <dt className="text-fg-secondary">Created</dt>
            <dd className="text-fg">{formatDateTime(endpoint.createdAt)}</dd>
          </dl>
          <p className="leading-snug text-fg-secondary">
            Your signed webhook URL is shown only once, when you create or rotate the endpoint.
            Rotate to mint a new one — the current URL stops working the moment you do.
          </p>
        </CardContent>
      </Card>

      <EndpointControls
        endpoint={endpoint}
        variant="buttons"
        rotateEndpoint={rotateEndpoint}
        deleteEndpoint={deleteEndpoint}
        // Soft-deleted: navigate to the list, which the action just revalidated (the deleted endpoint is
        // gone from its cache). The controls' latches need no reset — the page unmounts on navigation.
        onDeleted={() => router.push("/endpoints")}
      />
    </div>
  );
}
