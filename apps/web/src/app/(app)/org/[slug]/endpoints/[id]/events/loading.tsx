import { PageContainer } from "@webhook-co/ui";
// Instant navigation feedback for the endpoint events route (also force-dynamic with per-request reads).
// Mirrors the events page's max-w column: a header + a list of event-row placeholders.

export default function EndpointEventsLoading() {
  return (
    <PageContainer aria-busy>
      <div className="flex flex-col gap-1.5">
        <div className="h-4 w-24 animate-pulse rounded bg-surface-sunken" />
        <div className="h-8 w-32 animate-pulse rounded bg-surface-sunken" />
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-12 w-full animate-pulse rounded-card border border-hairline bg-surface"
          />
        ))}
      </div>
      <span className="sr-only">Loading events…</span>
    </PageContainer>
  );
}
