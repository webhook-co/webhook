import { CardsPageSkeleton } from "@/components/page-skeletons";

// Instant feedback for the account profile page (reached from the user menu's "Account settings"). The page
// awaits verifySession() before rendering, so without this a click showed a blank frame until it returned.
// Mirror the page's frame: a narrow (760px) gap-6 column of cards (identity + delete-account).
export default function Loading() {
  return <CardsPageSkeleton label="profile" size="narrow" gap="gap-6" cards={2} />;
}
