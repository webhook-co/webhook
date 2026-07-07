import { CopyButton } from "@webhook-co/ui";

import { revealEndpointIngestUrl } from "@/server/endpoint-reveal";

// The always-shown ingest URL, revealed on its OWN async boundary so it never blocks the endpoint-detail
// render (S8-remainder / ADR-0101). The reveal is a cross-cloud engine RPC (a cold Hyperdrive read + a
// first-call KMS unseal), so the page streams the rest immediately and this slot fills in behind a
// <Suspense> skeleton (see IngestUrlRevealSkeleton). `null` (no recoverable copy / a persisted transient
// after the retry-once) shows the rotate-to-reveal hint, exactly as before — just no longer on the page's
// critical path.

/** The placeholder shown while the reveal streams (the Suspense fallback). */
export function IngestUrlRevealSkeleton() {
  return (
    <div
      className="h-4 w-64 max-w-full animate-pulse rounded bg-surface-sunken"
      aria-hidden
      // The reveal is a non-blocking config read; announce nothing until it resolves.
    />
  );
}

export async function IngestUrlReveal({
  orgId,
  endpointId,
}: {
  orgId: string;
  endpointId: string;
}) {
  const ingestUrl = await revealEndpointIngestUrl({ orgId, endpointId });
  if (!ingestUrl) {
    return (
      <span className="text-fg-secondary">Unavailable — rotate to mint a fresh ingest URL.</span>
    );
  }
  return (
    <>
      <code className="min-w-0 flex-1 truncate font-mono text-fg">{ingestUrl}</code>
      <CopyButton value={ingestUrl} size="sm" />
    </>
  );
}
