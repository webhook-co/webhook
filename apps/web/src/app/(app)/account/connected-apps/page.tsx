import type { Metadata } from "next";
import { PageContainer } from "@webhook-co/ui";

import { ConnectedAppsManager } from "@/components/connected-apps-manager";
import { revokeConnectedApp } from "@/server/connected-apps-actions";
import { loadConnectedApps } from "@/server/connected-apps";

export const metadata: Metadata = {
  title: "Connected apps · webhook.co",
};

/**
 * The OAuth clients (Claude, Cursor, …) THIS USER has authorized.
 *
 * It lived at `/org/{slug}/settings/connected-apps`, gated on `requireOrgAccess` — and that gate was doing
 * nothing but proving membership of an org the page then ignored. `loadConnectedApps()` takes no `orgId`; it
 * cannot, because the answer does not depend on one. The old page even said so in a comment.
 *
 * That was not merely redundant, it was misleading: the SAME rows rendered under every org in the switcher,
 * which invites the reading that revoking Claude in Acme leaves it connected in your personal org. It does
 * not. There is one grant, and revoking it revokes it everywhere.
 *
 * dal-gate-allow: user-scoped — loadConnectedApps gates on verifySession and is bounded by the userId; there
 * is no org here to prove membership of.
 */
export default async function ConnectedAppsPage() {
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
