import { Button, Card, CardContent, PageContainer } from "@webhook-co/ui";
import type { Metadata } from "next";
import Link from "next/link";

import { requireOrgAccess } from "@/server/org-access";

export const metadata: Metadata = {
  title: "Organization suspended · webhook.co",
};

// The read-only suspension screen. Every DATA/READ page for a suspended org diverts here (via
// `requireActiveOrgAccess`); Settings and Billing stay reachable so the user can act. This page itself gates
// on plain `requireOrgAccess` — so it renders for a suspended org and the divert can't loop — and it is
// purely informational (no writes), which is what "read-only while suspended" means.
//
// If the org ISN'T suspended, there's nothing to show: send the user to the dashboard. That keeps the URL
// meaningful (someone who bookmarked /suspended, or whose org was just restored, lands somewhere real).

/** Reason-specific copy. Unknown reasons fall back to a generic message so a new reason never dead-ends. */
function suspensionCopy(reason: string | null): { heading: string; body: string; cta: string } {
  switch (reason) {
    case "free_org_cap":
      return {
        heading: "This organization is suspended",
        body:
          "It's over your free-organization limit, so it's been paused — inbound capture and outbound " +
          "delivery are held, and its data is read-only. Nothing has been deleted. Upgrade this organization " +
          "to a paid plan to restore it, or free up a slot by upgrading or removing another free organization.",
        cta: "Upgrade to restore",
      };
    default:
      return {
        heading: "This organization is suspended",
        body:
          "It's been paused — inbound capture and outbound delivery are held, and its data is read-only. " +
          "Nothing has been deleted. Visit billing to restore it.",
        cta: "Go to billing",
      };
  }
}

export default async function SuspendedPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // Plain gate (NOT requireActiveOrgAccess): this is the one read surface a suspended org may see, and gating
  // it on the active check would loop the redirect.
  const access = await requireOrgAccess(slug, "/suspended");

  const { heading, body, cta } = suspensionCopy(access.suspendedReason);

  return (
    <PageContainer size="narrow" gap="gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">{heading}</h1>
        <p className="leading-snug text-fg-secondary">{body}</p>
      </div>
      <Card>
        <CardContent className="flex flex-col items-start gap-4 pt-6">
          <p className="text-sm text-fg-secondary">
            {access.name} stays exactly as you left it while suspended. Restore it whenever
            you&apos;re ready — its endpoints, events, and settings are preserved.
          </p>
          <div className="flex gap-2">
            <Button asChild>
              <Link href={`/org/${access.slug}/billing`}>{cta}</Link>
            </Button>
            <Button asChild variant="secondary">
              <Link href={`/org/${access.slug}/settings`}>Organization settings</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
