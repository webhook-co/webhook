import { redirect } from "next/navigation";

// dal-gate-allow: owns no tenant data — an unconditional redirect to /org/{slug}/credentials, which gates for
// itself. It deliberately does NOT call requireOrgAccess: that would buy a directory read to validate a slug
// it is only ever going to hand straight back to a page that re-resolves it anyway. A slug that isn't yours
// still 404s — one hop later, at the destination.

// API keys & devices moved to the top-level /credentials section (above Settings). This stub keeps old
// bookmarks and links from 404ing — a permanent client redirect to the new home, now under the org.
export default async function MovedCredentials({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  redirect(`/org/${slug}/credentials`);
}
