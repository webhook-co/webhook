import { ListPageSkeleton } from "@/components/page-skeletons";

// Instant feedback for credentials — its N+1 read made this one of the slowest to first byte before Lane B,
// so a skeleton matters here most. The list shape stands in for both sections (device grants, standalone keys).
export default function Loading() {
  return <ListPageSkeleton label="API keys and devices" rows={5} columns={4} />;
}
