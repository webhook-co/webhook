import { ListPageSkeleton } from "@/components/page-skeletons";

// Instant feedback for the deliveries list — force-dynamic (per-request Postgres reads), so without this a
// navigation showed a blank frame until the server render finished. See page-skeletons.tsx.
export default function Loading() {
  return <ListPageSkeleton label="deliveries" />;
}
