import { Button, Card, CardContent, PageContainer } from "@webhook-co/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { requireOrgAccess } from "@/server/org-access";

export const metadata: Metadata = {
  title: "Organization suspended · webhook.co",
};

// The suspension screen. Every DATA/READ page for a suspended org diverts here (via
// `requireActiveOrgAccess`); Settings and Billing stay reachable so the user can act. This page itself gates
// on plain `requireOrgAccess` — so it renders for a suspended org and the divert can't loop — and it is
// purely informational (no writes).
//
// If the org ISN'T suspended, there's nothing to show: send the user to the dashboard. That keeps the URL
// meaningful (someone who bookmarked /suspended, or whose org was just restored, lands somewhere real).
//
// COPY, two things this page previously got wrong — it must stay in step with the cap emails
// (apps/auth/src/runtime/free-org-cap-email.ts), whose CTA lands the reader right here:
//
//  1. NOT "read-only". `requireActiveOrgAccess` REDIRECTS every data page to this screen; the data isn't
//     browsable-but-frozen, it's unreachable. Saying "read-only" sends the owner hunting for events they
//     cannot open.
//  2. NOT "nothing has been deleted / events are preserved". The ORG is never deleted, but retention.ts
//     prunes EVENTS purely on `received_at` with no `orgs.status` predicate (webhook_retention's grant on orgs
//     is (id, retention_days) — it cannot even see suspension), so on the free plan's window a suspended org's
//     history ages away while the owner sits on this reassurance. Config is kept; events are not.
//
// There is also no restore deadline to state: restoration is available indefinitely. (0083 carried an
// `orgs.restore_deadline` column for a hard-delete slice that was never built; nothing read it, it produced
// two rounds of false copy, and 0087 dropped it.)

/**
 * Reason-specific copy. Unknown reasons fall back to a generic message so a new reason never dead-ends.
 *
 * `detail` is part of the SWITCH, not rendered unconditionally below it: its facts (restoration never
 * expires; events aging out on the free plan's retention) are true only for THIS reason. Retention is
 * plan-specific, and a future suspension reason may well carry a real deadline — a paid org suspended for
 * non-payment is the obvious one. Each reason states its own facts.
 */
function suspensionCopy(reason: string | null): {
  heading: string;
  body: string;
  detail: (orgName: string) => string;
  cta: string;
} {
  switch (reason) {
    case "free_org_cap":
      return {
        heading: "This organization is suspended",
        body:
          "It's over the free plan's per-user organization limit, so it's been paused — inbound capture and " +
          "outbound delivery are held, and its data isn't reachable while it's suspended. Upgrade this " +
          "organization to a paid plan to restore it, or free up a slot by upgrading or removing another " +
          "free organization owned by the same person.",
        detail: (orgName) =>
          `${orgName}'s endpoints, destinations, settings, and team are all kept, and restoring puts them ` +
          `back. Events are the one thing that doesn't wait: they keep aging out on the free plan's usual ` +
          `retention while it's suspended, so the sooner you restore it, the more history you keep.`,
        cta: "Upgrade to restore",
      };
    default:
      return {
        heading: "This organization is suspended",
        body:
          "It's been paused — inbound capture and outbound delivery are held, and its data isn't reachable " +
          "while it's suspended. Visit billing to restore it.",
        detail: (orgName) =>
          `${orgName}'s endpoints, destinations, settings, and team are all kept, and restoring puts them back.`,
        cta: "Go to billing",
      };
  }
}

export default async function SuspendedPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // Plain gate (NOT requireActiveOrgAccess): this is the one read surface a suspended org may see, and gating
  // it on the active check would loop the redirect.
  const access = await requireOrgAccess(slug, "/suspended");

  // If the org ISN'T suspended, there's nothing to show — send the user somewhere real. This covers a stale
  // bookmark and, more importantly, the just-restored case: an owner sitting on /suspended when the org flips
  // back to active must not keep seeing the alarming "your org is paused" screen for a healthy org.
  if (access.status !== "suspended") {
    redirect(`/org/${access.slug}/dashboard`);
  }

  const { heading, body, detail, cta } = suspensionCopy(access.suspendedReason);

  return (
    <PageContainer size="narrow" gap="gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">{heading}</h1>
        <p className="leading-snug text-fg-secondary">{body}</p>
      </div>
      <Card>
        <CardContent className="flex flex-col items-start gap-4 pt-6">
          <p className="text-sm text-fg-secondary">{detail(access.name)}</p>
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
