import type { Metadata } from "next";

import { CredentialsManager } from "@/components/credentials-manager";
import { createApiKey } from "@/server/credential-actions";
import { loadCredentials } from "@/server/credentials";
import { verifySession } from "@/server/session";

export const metadata: Metadata = {
  title: "API keys & devices · webhook.co",
};

export default async function CredentialsPage() {
  const session = await verifySession();
  const result = await loadCredentials(session.orgId);

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-8 p-8">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">API keys &amp; devices</h1>
        <p className="leading-snug text-fg-secondary">
          The keys and devices authorized for your organization. Revoking a device cascades to the
          keys minted under it.
        </p>
      </div>
      <CredentialsManager initialResult={result} createKey={createApiKey} />
    </div>
  );
}
