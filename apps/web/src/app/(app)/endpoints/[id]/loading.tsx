// Instant navigation feedback for the endpoint detail route. The page is force-dynamic (it does a couple of
// per-request Postgres reads before it can render), so without this skeleton a click on an endpoint name
// showed nothing until the server render finished. Next.js renders this instantly on navigation. Mirrors the
// detail page's max-w column + its three stacked cards (detail / provider secrets / deduplication).

function SkeletonCard({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-4 rounded-card border border-hairline bg-surface p-6">
      <div className="h-5 w-40 animate-pulse rounded bg-surface-sunken" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-4 w-full max-w-md animate-pulse rounded bg-surface-sunken" />
      ))}
    </div>
  );
}

export default function EndpointDetailLoading() {
  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-8 p-8" aria-busy>
      <div className="flex flex-col gap-1.5">
        <div className="h-4 w-24 animate-pulse rounded bg-surface-sunken" />
        <div className="h-8 w-40 animate-pulse rounded bg-surface-sunken" />
      </div>
      <SkeletonCard rows={3} />
      <SkeletonCard rows={2} />
      <SkeletonCard rows={2} />
      <span className="sr-only">Loading endpoint…</span>
    </div>
  );
}
