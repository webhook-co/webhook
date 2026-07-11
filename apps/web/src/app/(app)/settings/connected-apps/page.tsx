import type { Metadata } from "next";

import { ConnectedAppsManager } from "@/components/connected-apps-manager";
import { revokeConnectedApp } from "@/server/connected-apps-actions";
import { loadConnectedApps } from "@/server/connected-apps";

export const metadata: Metadata = {
  title: "Connected apps · webhook.co",
};

export default async function ConnectedAppsPage() {
  const result = await loadConnectedApps();

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-8 p-8">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">Connected apps</h1>
        <p className="leading-snug text-fg-secondary">
          Apps you&rsquo;ve authorized to access your webhook.co account over OAuth. Revoking an app
          immediately cuts off its access.
        </p>
      </div>

      {result.status === "unavailable" ? (
        <p className="text-sm text-fg-secondary">
          Connected apps are temporarily unavailable. Please try again shortly.
        </p>
      ) : (
        <ConnectedAppsManager initialApps={result.apps} revoke={revokeConnectedApp} />
      )}
    </div>
  );
}
