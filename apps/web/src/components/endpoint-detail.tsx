"use client";

import { Badge, Card, CardContent, CardHeader, CardTitle, CopyButton } from "@webhook-co/ui";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { formatDateTime } from "@/lib/format";
import type { EndpointActionResult, RotateEndpointResult } from "@/server/endpoint-actions";
import type { EndpointItem } from "@/server/endpoints";

import { EndpointControls } from "./endpoint-controls";

export interface EndpointDetailProps {
  endpoint: EndpointItem;
  /**
   * The always-shown wbhk.my/<token> ingest URL cell (S8-remainder / ADR-0101), rendered as a server-composed
   * SLOT so the reveal (a cross-cloud engine RPC) streams in behind its own <Suspense> boundary instead of
   * blocking this render. The page passes `<Suspense fallback={…}><IngestUrlReveal …/></Suspense>`.
   */
  ingestUrlSlot: ReactNode;
  /** Rotate the ingest token (hard cutover) → the NEW one-time URL. Injected by the gated page. */
  rotateEndpoint: (endpointId: string) => Promise<RotateEndpointResult>;
  /** Soft-delete the endpoint. Injected by the gated page. */
  deleteEndpoint: (endpointId: string) => Promise<EndpointActionResult>;
}

export function EndpointDetail({
  endpoint,
  ingestUrlSlot,
  rotateEndpoint,
  deleteEndpoint,
}: EndpointDetailProps) {
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
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-2 text-sm">
            <dt className="text-fg-secondary">Ingest URL</dt>
            <dd className="flex min-w-0 items-center gap-2">{ingestUrlSlot}</dd>
            <dt className="text-fg-secondary">Endpoint ID</dt>
            <dd className="flex min-w-0 items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-fg">{endpoint.id}</code>
              <CopyButton value={endpoint.id} size="sm" />
            </dd>
            <dt className="text-fg-secondary">Created</dt>
            <dd className="text-fg">{formatDateTime(endpoint.createdAt)}</dd>
          </dl>
          <p className="leading-snug text-fg-secondary">
            Send webhooks to this URL. Rotating mints a new one and stops the current URL the moment
            you do — for a leaked or lost URL.
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
        // After a rotate reveal is dismissed, re-fetch this server component so the always-shown ingest URL
        // updates from the stale pre-rotate token to the newly-minted one (ADR-0101).
        onRotated={() => router.refresh()}
      />
    </div>
  );
}
