import { CardsPageSkeleton } from "@/components/page-skeletons";

// Instant feedback for org settings — the page awaits membership + tenant reads (requireOrgAccess, getTenantDb,
// isPersonalOrg, getOrgImageKey) before rendering, so without this a click showed nothing until it returned.
// Mirror the page's own frame: a narrow (760px) gap-6 column of cards (Organization + Delete-org).
export default function Loading() {
  return <CardsPageSkeleton label="settings" size="narrow" gap="gap-6" cards={2} />;
}
