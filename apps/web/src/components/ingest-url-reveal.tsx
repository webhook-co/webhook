import { CopyButton } from "@webhook-co/ui";

import { recordIngestUrlDisclosure, revealEndpointIngestUrl } from "@/server/endpoint-reveal";

// The always-shown ingest URL, revealed on its OWN async boundary so it never blocks the endpoint-detail
// render (S8-remainder / ADR-0101). The reveal is a cross-cloud engine RPC (a cold Hyperdrive read + a
// first-call KMS unseal), so the page streams the rest immediately and this slot fills in behind a
// <Suspense> skeleton (see IngestUrlRevealSkeleton). The two non-URL states show DIFFERENT copy so a merely
// transient failure never advises the destructive rotate: `no-copy` (a legacy endpoint whose token is gone)
// points to rotate; `unavailable` (a transient reveal fault) points to refresh, NOT rotate.

/** The placeholder shown while the reveal streams (the Suspense fallback). */
export function IngestUrlRevealSkeleton() {
  return (
    <div role="status" aria-live="polite" className="flex min-w-0 items-center">
      <span className="h-4 w-64 max-w-full animate-pulse rounded bg-surface-sunken" aria-hidden />
      <span className="sr-only">Loading ingest URL…</span>
    </div>
  );
}

export async function IngestUrlReveal({
  orgId,
  userId,
  endpointId,
}: {
  orgId: string;
  userId: string;
  endpointId: string;
}) {
  const reveal = await revealEndpointIngestUrl({ orgId, endpointId });
  if (reveal.kind === "url") {
    // The URL (a bearer credential) is now disclosed to this human — record the FIRST such disclosure to the
    // audit chain (deduped, best-effort; never blocks or blanks this render). S.9.
    await recordIngestUrlDisclosure({ orgId, userId, endpointId });
    return (
      <>
        <code className="min-w-0 flex-1 truncate font-mono text-fg">{reveal.url}</code>
        <CopyButton value={reveal.url} size="sm" />
      </>
    );
  }
  if (reveal.kind === "no-copy") {
    // The endpoint predates recoverable URLs — its token is one-way-hashed and gone. Rotating IS the fix.
    return (
      <span className="text-fg-secondary">
        No saved URL for this endpoint — rotate to mint a fresh one.
      </span>
    );
  }
  // Transient reveal fault: the token still exists. Refresh to retry — do NOT rotate (that's a hard cutover
  // that would invalidate the still-working URL for every configured sender).
  return (
    <span className="text-fg-secondary">
      Couldn&apos;t load the ingest URL — refresh to try again.
    </span>
  );
}
