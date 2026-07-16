import { listOwnedOrgsForCap } from "@webhook-co/db/org-lifecycle";
import { MAX_FREE_ORGS_PER_USER } from "@webhook-co/shared/plans";
import { PageContainer } from "@webhook-co/ui";
import type { Metadata } from "next";

import { OrgCapPicker } from "@/components/org-cap-picker";
import { getTenantDb } from "@/server/db";
import { verifySession } from "@/server/session";

export const metadata: Metadata = {
  title: "Organizations · webhook.co",
};

/**
 * Your organizations, and which of the free ones you want to keep (PR2b slice 5).
 *
 * Lives under /account rather than /org/{slug} because the free-org cap is a property of the PERSON: it
 * counts the free orgs YOU own, across all of them. There is no single org this page is about, so there is no
 * slug in the URL and no org to gate on — the account layout's doctrine exactly.
 *
 * WHY A PICKER AT ALL. The reconciler's default is "keep the oldest `cap`, suspend the rest", which is a
 * reasonable guess and a terrible one to be stuck with: the org you created first is very often the throwaway
 * you were experimenting in, and the newest is the one carrying live traffic. Auto-picking the wrong victim
 * is the thing that generates support tickets. So the default stands, and this page lets you override it.
 *
 * WHAT IT DELIBERATELY DOESN'T DO: predict. It shows your orgs and your marks, not "this one will be
 * suspended". Only the reconciler can know that — a co-owned org is overflow if it is overflow for ANY of its
 * owners, and this page (running as webhook_app) cannot see another user's org list to work that out.
 * Claiming an outcome we can't compute is how the emails in this lane went wrong twice.
 *
 * dal-gate-allow: user-scoped — gates on verifySession; the read is per-user (user_org_directory) plus a
 * per-org tenant read for each org this user owns. There is no ambient org here.
 */
export default async function AccountOrganizationsPage() {
  const session = await verifySession();
  const app = await getTenantDb();
  const orgs = await listOwnedOrgsForCap(app, session.userId);

  return (
    <PageContainer size="narrow" gap="gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">Organizations</h1>
        <p className="leading-snug text-fg-secondary">
          The organizations you own. The free plan covers up to {MAX_FREE_ORGS_PER_USER} of them per
          person — if you go over, you choose which ones stay.
        </p>
      </div>
      <OrgCapPicker orgs={orgs} cap={MAX_FREE_ORGS_PER_USER} />
    </PageContainer>
  );
}
