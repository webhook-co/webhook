import { CardsPageSkeleton } from "@/components/page-skeletons";

// Instant feedback for usage — force-dynamic, so a click showed nothing until the server render returned.
export default function Loading() {
  return <CardsPageSkeleton label="usage" cards={3} />;
}
