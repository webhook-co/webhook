import { isPersonalOrg } from "@webhook-co/db/org-lifecycle";
import { PageContainer } from "@webhook-co/ui";
import type { Metadata } from "next";
import Link from "next/link";

import { DeleteOrgCard } from "@/components/delete-org-card";
import { RenameOrgCard } from "@/components/rename-org-card";
import { getTenantDb } from "@/server/db";
import { requireOrgAccess } from "@/server/org-access";
import { renameOrgAction } from "@/server/org-actions";

export const metadata: Metadata = {
  title: "Settings · webhook.co",
};

export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await requireOrgAccess(slug, "/settings");
  // The org's authoritative display name comes from the SAME directory read that proved membership (on
  // `session.name`) — never inferred from the slug. An earlier version fell back to the slug when a second,
  // redundant directory read didn't contain the org; that fallback could seed the rename form's Name field
  // with the slug and, on submit, persist the slug AS the display name. Reading the one authoritative value
  // removes both the extra query and the corruption path.
  // Renaming changes the org's public address and retires the old one forever, so it is owner/admin only —
  // enforced server-side in renameOrg; the card is read-only for a plain member.
  const canRename = session.role === "owner" || session.role === "admin";
  // The personal org can't be deleted (deleteOrganization refuses it, shedding it is Delete-account's job)
  // — so don't render a dead button. Uses the same ORG-centric check as the server guard (an org is
  // personal iff one of its owners' personalOrgId equals it), so a co-owner viewing it sees no card either.
  const personal = await isPersonalOrg(await getTenantDb(), session.orgId);

  return (
    <PageContainer size="narrow" gap="gap-6">
      {/* ORG settings. Everything user-scoped — your profile, the apps YOU authorized, deleting your account —
          moved to /account, where the URL matches the scope. What is left here genuinely belongs to the org:
          its name, its address, and ending it. */}
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">Organization settings</h1>
        <p className="leading-snug text-fg-secondary">
          Settings for {session.name}. Looking for your profile or connected apps?{" "}
          <Link href="/account/profile" className="text-fg underline underline-offset-4">
            They&apos;re in your account
          </Link>
          .
        </p>
      </div>

      <RenameOrgCard
        slug={session.slug}
        name={session.name}
        rename={renameOrgAction.bind(null, session.slug)}
        canRename={canRename}
      />

      {!personal && <DeleteOrgCard slug={session.slug} />}
    </PageContainer>
  );
}
