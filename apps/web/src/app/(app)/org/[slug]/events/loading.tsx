import { ListPageSkeleton } from "@/components/page-skeletons";

// Instant feedback for the org-wide events browse — the page does per-request Postgres reads (loadOrgEvents)
// before it can render, so without this a navigation showed a blank frame until the server render finished.
// The page uses the default-width PageContainer + a table (OrgEventsList), so the list skeleton matches.
export default function Loading() {
  return <ListPageSkeleton label="events" />;
}
