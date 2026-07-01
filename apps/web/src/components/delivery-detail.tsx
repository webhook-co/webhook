"use client";

import {
  Banner,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CopyButton,
  StatusPill,
} from "@webhook-co/ui";

import { deliveryCopy } from "@/lib/delivery-copy";
import { formatDateTime } from "@/lib/format";
import type { DeliveryItem } from "@/server/deliveries";

// One delivery — the tenant-facing read view of a delivery attempt. The status pill + hint come from the
// single `deliveryCopy` source (never the raw enum); the retry clock, status code, routing links, and the
// engine's error string are laid out plainly for a developer inspecting why a webhook did (or didn't)
// arrive. We never imply more than is true — the `blocked` hint speaks generally (the delivery guard
// refused the destination) and the per-row `error` below carries the exact reason; we don't editorialize.
export interface DeliveryDetailProps {
  delivery: DeliveryItem;
}

export function DeliveryDetail({ delivery }: DeliveryDetailProps) {
  const copy = deliveryCopy(delivery.status, { nextRetryAt: delivery.nextRetryAt });

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>Delivery</CardTitle>
          <StatusPill tone={copy.tone}>{copy.label}</StatusPill>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {copy.hint ? <p className="leading-snug text-fg-secondary">{copy.hint}</p> : null}

          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-fg-secondary">Event ID</dt>
            <dd className="flex items-center gap-2">
              <code className="font-mono text-fg">{delivery.eventId}</code>
              <CopyButton value={delivery.eventId} size="sm" />
            </dd>

            <dt className="text-fg-secondary">Status code</dt>
            <dd className="text-fg">{delivery.statusCode ?? "—"}</dd>

            <dt className="text-fg-secondary">Attempt</dt>
            <dd className="text-fg">{delivery.attempt}</dd>

            <dt className="text-fg-secondary">Destination</dt>
            <dd className="text-fg">
              {delivery.destinationId ? (
                <code className="font-mono text-fg">{delivery.destinationId}</code>
              ) : delivery.status === "forwarded" ? (
                // A null destination on a `forwarded` row is the legacy localhost-tunnel replay.
                "localhost"
              ) : (
                "—"
              )}
            </dd>

            {delivery.subscriptionId ? (
              <>
                <dt className="text-fg-secondary">Subscription</dt>
                <dd>
                  <code className="font-mono text-fg">{delivery.subscriptionId}</code>
                </dd>
              </>
            ) : null}

            {delivery.nextRetryAt ? (
              <>
                <dt className="text-fg-secondary">Next retry</dt>
                <dd className="text-fg">{formatDateTime(delivery.nextRetryAt)}</dd>
              </>
            ) : null}

            <dt className="text-fg-secondary">Created</dt>
            <dd className="text-fg">{formatDateTime(delivery.createdAt)}</dd>
          </dl>

          {delivery.error ? <Banner tone="danger">{delivery.error}</Banner> : null}
        </CardContent>
      </Card>
    </div>
  );
}
