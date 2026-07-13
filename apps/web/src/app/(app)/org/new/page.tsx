import { PageContainer } from "@webhook-co/ui";
import type { Metadata } from "next";

import { CreateTeamForm } from "@/components/create-team-form";
import { createTeamAction } from "@/server/org-create-actions";
import { verifySession } from "@/server/session";

export const metadata: Metadata = {
  title: "Create a team · webhook.co",
};

// `/org/new` — create a new organization.
//
// It lives OUTSIDE the `[slug]` group (a static segment beats the dynamic one, and `new` is a reserved slug so
// no real org can ever shadow it), which means it is NOT covered by the org render gate — it gates itself. And
// it gates on verifySession, NOT requireOrgAccess: you don't belong to the org you're about to create, so
// there is no membership to check. Any authenticated user may create a team and becomes its owner.
export default async function NewOrgPage() {
  await verifySession(); // dal-gate: any signed-in user may create a team

  return (
    <PageContainer size="narrow" gap="gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">Create a team</h1>
        <p className="leading-snug text-fg-secondary">
          A team is a separate organization with its own endpoints, members, and billing.
          You&apos;ll be its owner. You can rename it — and change its URL — any time in settings.
        </p>
      </div>
      <CreateTeamForm create={createTeamAction} />
    </PageContainer>
  );
}
