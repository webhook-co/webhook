import type { Metadata } from "next";
import { PageContainer } from "@webhook-co/ui";

import { ConnectedAppsManager } from "@/components/connected-apps-manager";
import { revokeConnectedApp } from "@/server/connected-apps-actions";
import { loadConnectedApps } from "@/server/connected-apps";
import { requireOrgAccess } from "@/server/org-access";

export const metadata: Metadata = {
  title: "Connected apps · webhook.co",
};

export default async function ConnectedAppsPage({ params }: { params: Promise<{ slug: string }> }) {
  // Gate first: membership is re-read per request against the org NAMED IN THE URL, so a slug the user is not
  // a member of cannot render this. It leans on no data from the gate — the point is the refusal, not the
  // return value. (The connected apps themselves are USER-scoped, not org-scoped — loadConnectedApps takes no
  // org — so nothing below needs the orgId.)
  const { slug } = await params;
  await requireOrgAccess(slug, "/settings/connected-apps");
  const result = await loadConnectedApps();

  return (
    <PageContainer>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">Connected apps</h1>
        <p className="leading-snug text-fg-secondary">
          Apps you&rsquo;ve authorized to access your webhook.co account over OAuth. Revoking an app
          immediately cuts off its access.
        </p>
      </div>

      {result.status === "unavailable" ? (
        <p className="text-fg-secondary">
          Connected apps are temporarily unavailable. Please try again shortly.
        </p>
      ) : (
        <ConnectedAppsManager initialApps={result.apps} revoke={revokeConnectedApp} />
      )}
    </PageContainer>
  );
}
