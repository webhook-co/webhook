import { PageContainer, Skeleton, SkeletonText } from "@webhook-co/ui";

// Instant navigation feedback for the dashboard's force-dynamic pages. Each does a few per-request Postgres
// reads before it can render, so without a loading fallback a click showed NOTHING until the server render came
// back — a blank frame that reads as "hung", on exactly the pages this whole effort is trying to make feel
// faster. Next renders the route's `loading.tsx` INSTANTLY on navigation; these hold the page's shape while the
// real data loads.
//
// Each mirrors its page's actual layout, because a skeleton that does not match the thing it stands in for
// produces a visible JUMP when the content arrives — which is worse than no skeleton, since it draws the eye to
// the reflow. So the header block, the card, the table all sit where the real ones will.

/** The page's heading + subheading — every dashboard page opens with one. */
function HeaderSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-72 max-w-full" />
    </div>
  );
}

/** A card-shaped block: a titled panel with a few lines of body. */
export function CardSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="flex flex-col gap-4 rounded-card border border-hairline bg-surface p-6">
      <Skeleton className="h-5 w-40" />
      <SkeletonText lines={lines} />
    </div>
  );
}

/**
 * A table skeleton — a header strip over a handful of rows. The list pages (endpoints, deliveries, team,
 * triggers, destinations, audit) are all this shape.
 */
export function TableSkeleton({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="overflow-hidden rounded-card border border-hairline bg-surface">
      <div className="flex items-center gap-4 border-b border-hairline px-4 py-3">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className="h-3.5 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          className="flex items-center gap-4 border-b border-hairline px-4 py-4 last:border-b-0"
        >
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton key={c} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

/** The standard "heading, then a table" list page. */
export function ListPageSkeleton({
  label,
  rows = 6,
  columns = 4,
}: {
  label: string;
  rows?: number;
  columns?: number;
}) {
  return (
    <PageContainer aria-busy>
      <HeaderSkeleton />
      <TableSkeleton rows={rows} columns={columns} />
      <span className="sr-only">{`Loading ${label}…`}</span>
    </PageContainer>
  );
}

/** A page built from stacked cards (dashboard overview, billing). */
export function CardsPageSkeleton({ label, cards = 2 }: { label: string; cards?: number }) {
  return (
    <PageContainer aria-busy>
      <HeaderSkeleton />
      {Array.from({ length: cards }).map((_, i) => (
        <CardSkeleton key={i} />
      ))}
      <span className="sr-only">{`Loading ${label}…`}</span>
    </PageContainer>
  );
}
